import { z } from "zod";
import { apiFetch, apiFetchText, type ApiConfig } from "./api-client.js";

// Tool definitions for the MCP server. Each tool has:
//   - name + description (what the LLM sees)
//   - zod input schema (what the LLM is allowed to send)
//   - handler (what we run on call)
//
// We keep the input schemas LLM-friendly — flat, all top-level params,
// explicit enums where useful. The richer flow-config validation lives
// server-side in the appmate repo; we re-state only the shape here.

export type ToolDef<I extends z.ZodTypeAny> = {
  name: string;
  description: string;
  inputSchema: I;
  handler: (input: z.infer<I>, cfg: ApiConfig) => Promise<unknown>;
};

// `config` for the update_*_draft tools is a full flow-config OBJECT. We
// must advertise it as `type: object` in the JSON schema (see zodToJsonSchema
// in index.ts) — otherwise an untyped field leads some MCP hosts to serialize
// it to a JSON string, which the server then rejects with
// `422: expected object, received string`.
//
// Belt-and-braces: we ALSO accept a JSON string and parse it here (via
// z.preprocess), since a few hosts stringify nested args regardless. Either
// way the server receives a real object, never `"{...}"`.
function parseJsonStringConfig(v: unknown): unknown {
  if (typeof v === "string") {
    const trimmed = v.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch {
        // Not valid JSON — leave it; record validation reports a clear error.
      }
    }
  }
  return v;
}

// Shared input for every update_*_draft tool: an app reference + the full
// config object. The inner record makes `config` advertise `type: object`;
// the preprocess tolerates a stringified body.
const updateDraftInput = z.object({
  appIdOrSlug: z.string().min(1),
  config: z.preprocess(
    parseJsonStringConfig,
    z.record(z.string(), z.unknown()),
  ),
});

// ─── Apps ───────────────────────────────────────────────────────────────────

export const listApps: ToolDef<z.ZodObject<{}>> = {
  name: "list_apps",
  description:
    "List every AppMate app the API token can see. Returns id, slug, name, bundleId, deepLinkScheme, logoUrl, timestamps.",
  inputSchema: z.object({}),
  handler: (_input, cfg) => apiFetch(cfg, "GET", "/api/v1/apps"),
};

export const getApp: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_app",
  description:
    "Fetch a single AppMate app by its cuid id or slug. Use list_apps first if you don't know either.",
  inputSchema: z.object({
    appIdOrSlug: z
      .string()
      .min(1)
      .describe("Either the app's cuid id or its slug."),
  }),
  handler: (input, cfg) =>
    apiFetch(cfg, "GET", `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}`),
};

export const createApp: ToolDef<
  z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
    bundleId: z.ZodOptional<z.ZodString>;
    deepLinkScheme: z.ZodOptional<z.ZodString>;
    logoUrl: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "create_app",
  description:
    "Create a new AppMate app. The slug auto-derives from the name when omitted.",
  inputSchema: z.object({
    name: z.string().min(1).max(120),
    slug: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    bundleId: z.string().max(200).optional(),
    deepLinkScheme: z
      .string()
      .max(40)
      .regex(/^[a-z][a-z0-9+.-]*$/)
      .optional(),
    logoUrl: z.string().url().optional(),
  }),
  handler: (input, cfg) => apiFetch(cfg, "POST", "/api/v1/apps", input),
};

// ─── Pre-cancel flow ────────────────────────────────────────────────────────

export const getCancelFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_cancel_flow",
  description:
    "Read the published and draft cancel flow configs for an app.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/cancel`,
    ),
};

// `config` is the full flow-config object (advertised as type:object via
// updateDraftInput so hosts pass structured JSON). The server holds the
// canonical Zod schema: it returns 422 with paths on validation errors AND a
// `warnings` array on success for soft mismatches (e.g. showThanksScreen + a
// "Contact support" label).
export const updateCancelDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_cancel_draft",
  description: [
    "Replace the draft cancel flow config. Body MUST be a full cancel config object (type: 'cancel').",
    "",
    "Required shape (paste-and-fill):",
    "  {",
    "    type: 'cancel',",
    "    intro: { title, subtitle, primaryButton, secondaryButton },",
    "    reasonScreen: {",
    "      title, subtitle,",
    "      reasons: [ { id: snake_case, label, iconName? (lucide name), emoji? (one char) } ],",
    "      autoAdvance?: boolean,",
    "      selectMode?: 'single' (default) | 'multi'   // multi skips response screens",
    "    },",
    "    responses: {",
    "      <reasonId>: {",
    "        title, body,",
    "        primaryButton: { label, action, ...actionParams },",
    "        secondaryButton?: { label, action, ...actionParams },",
    "        showThanksScreen?: boolean       // true = no deep link, lands on thanks",
    "      }",
    "    },",
    "    showBackButton?: boolean (default true)",
    "  }",
    "",
    "Action types and their params:",
    "  return_to_app                                     close flow, back to app",
    "  manage_subscription                               open Apple subs UI (escape hatch)",
    "  open_offer        { offerId: string }             iOS app applies a StoreKit promo",
    "  open_premium      { paywallId?: string }          iOS paywall (optional variant id)",
    "  open_support      { supportTopic?, message? }     iOS support inbox",
    "  open_feature      { featureId: string }           deep-link an in-app screen",
    "  external_url      { url: https://… }              open URL in browser",
    "  none                                              record click, do nothing",
    "",
    "CRITICAL gotcha — showThanksScreen suppresses the deep link.",
    "  Set showThanksScreen:true ONLY when the click itself IS the signal you want.",
    "  Label the button feedback-shaped: 'Send feedback', 'Tell us why'.",
    "  DO NOT pair showThanksScreen:true with destination-shaped labels like",
    "  'Contact support', 'Claim 20% off', 'Open tutorial' — the user taps,",
    "  lands on a generic thanks screen, and the promise the label made silently breaks.",
    "",
    "The server returns { ok:true, warnings: [...] } on success — ALWAYS check warnings",
    "and re-PUT a corrected config before publishing if any are returned.",
    "Common warning codes:",
    "  thanks_screen_blocks_navigation, missing_response, responses_unused_in_multi_mode,",
    "  placeholder_offer_id, placeholder_feature_id, placeholder_external_url",
    "",
    "See https://docs.appmate.cloud/ai-agents for the full do/don't guide and examples.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/cancel`,
      input.config,
    ),
};

export const publishCancelFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_cancel_flow",
  description:
    "Promote the draft cancel config to the live published version. The live cancel URL flips on success. ALWAYS review the warnings array returned from the most recent update_cancel_draft call and fix any reported issues BEFORE publishing — publishing locks the broken flow in front of real users.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/cancel/publish`,
    ),
};

// ─── Waitlist flow ──────────────────────────────────────────────────────────

export const getWaitlistFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_waitlist_flow",
  description: "Read the published and draft waitlist flow configs for an app.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/waitlist`,
    ),
};

export const updateWaitlistDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_waitlist_draft",
  description: [
    "Replace the draft waitlist config. Body MUST be a full waitlist config object (type: 'waitlist').",
    "",
    "The public URL at signup.appmate.cloud/{slug} renders a FULL landing",
    "page — not just a form. The `hero` block drives the visual treatment;",
    "omit it for the minimal/legacy look.",
    "",
    "Full shape:",
    "  {",
    "    type: 'waitlist',",
    "    intro: {",
    "      title,            // h1 on the landing",
    "      subtitle,         // lede paragraph",
    "      emailPlaceholder, // input placeholder, e.g. 'you@example.com'",
    "      submitLabel,      // button text, e.g. 'Notify me'",
    "      legal?            // small print under the form (optional)",
    "    },",
    "    success: {",
    "      title, body,      // shown after signup",
    "      ctaLabel?, ctaUrl?   // both-or-neither — partial pair renders nothing",
    "    },",
    "    hero?: {              // ALL fields optional; omit `hero` entirely for minimal",
    "      theme?: 'minimal' | 'gradient' | 'dark' | 'side_by_side',",
    "      eyebrow?: string,   // short chip above title, e.g. 'Coming soon · Q1 2026'",
    "      accentColor?: string, // hex '#rrggbb'; tints button + chip + gradient blob",
    "      bullets?: [           // 0–5 value-prop cards, stacked one per row under the form",
    "        { icon?: '✨', title: 'Fast', body?: 'Sub-second responses' }",
    "      ],",
    "      showCount?: boolean,  // renders '{N} on the waitlist' pill (hides if <3 signups)",
    "      heroImage?: string,   // optional URL of a hero image",
    "    },",
    "    templateId?: string     // analytics tag if seeded from a template",
    "  }",
    "",
    "Theme picker guide — pick from intent:",
    "  - minimal       → no brand, conservative B2B. Default.",
    "  - gradient      → marketing-launch energy. Pastel blobs + accent color.",
    "  - dark          → premium / product-reveal vibe. Dark hero + accent glow.",
    "  - side_by_side  → desktop-first 2-column (story left, form right).",
    "                    Collapses to minimal on phone — fine for landing-pageiness.",
    "",
    "Starter templates available (see /examples?kind=waitlist):",
    "  minimal_email_only, feature_tease, launching_soon, pro_upsell,",
    "  private_beta, early_access_referral.",
    "",
    "Server returns { ok:true, warnings: [...] } — check warnings before publishing.",
    "Common warnings: partial_cta (label without url, or vice versa).",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/waitlist`,
      input.config,
    ),
};

export const publishWaitlistFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_waitlist_flow",
  description: "Promote the draft waitlist config to the live published version.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/waitlist/publish`,
    ),
};

// ─── Waitlist signups ───────────────────────────────────────────────────────

export const listWaitlistSignups: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_waitlist_signups",
  description:
    "Paginated list of waitlist signups for an app. Returns up to `limit` rows (max 200, default 50) and a `nextCursor` to pass back for the next page.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/waitlist/signups${tail}`,
    );
  },
};

export const exportWaitlistCsv: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "export_waitlist_csv",
  description:
    "Return the full waitlist for an app as a CSV string (header row + one row per signup). Useful for hand-off to spreadsheet or mail merge.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: async (input, cfg) => {
    const csv = await apiFetchText(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/waitlist/signups.csv`,
    );
    return { csv };
  },
};

// ─── Feedback flow ──────────────────────────────────────────────────────────

export const getFeedbackFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_feedback_flow",
  description:
    "Read the published and draft feedback flow configs for an app. Feedback flows host an open-ended message form (optional 1–5 star rating + optional reply email) at appmate.cloud/feedback/{appSlug}.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/feedback`,
    ),
};

export const updateFeedbackDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_feedback_draft",
  description: [
    "Replace the draft feedback config. Body MUST be a full feedback config object (type: 'feedback').",
    "",
    "Shape:",
    "  {",
    "    type: 'feedback',",
    "    layout: 'steps' | 'single',  // optional, default 'steps' (multi-step: rating+message, then email). 'single' = one screen.",
    "    intro: {",
    "      title, subtitle,",
    "      messagePlaceholder,           // textarea placeholder",
    "      submitLabel,",
    "      legal?                        // small print under the form (optional)",
    "    },",
    "    rating?: {                      // OPTIONAL 1–5 star widget",
    "      enabled: true,",
    "      prompt?: 'How would you rate your experience?',",
    "      required?: false              // when true, blocks submit until picked",
    "    },",
    "    emailField?: {                  // OPTIONAL reply-to email field",
    "      enabled: true,",
    "      placeholder?: 'you@example.com (optional)',",
    "      required?: false",
    "    },",
    "    success: {",
    "      title, body,",
    "      ctaLabel?, ctaUrl?            // both-or-neither follow-up CTA",
    "    },",
    "    hero?: {                        // visual treatment, matches waitlist hero",
    "      theme?: 'minimal' | 'gradient' | 'dark' | 'side_by_side',",
    "      eyebrow?, accentColor?, titleFont?",
    "    }",
    "  }",
    "",
    "Server returns { ok:true, warnings: [] }. Warning rules will be added later — for now treat any non-empty array as advisory.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/feedback`,
      input.config,
    ),
};

export const publishFeedbackFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_feedback_flow",
  description:
    "Promote the draft feedback config to the live published version. Visitors at appmate.cloud/feedback/{appSlug} see the new version immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/feedback/publish`,
    ),
};

export const listFeedbackSubmissions: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_feedback_submissions",
  description:
    "Paginated list of feedback submissions for an app. Each row: { id, message, rating, email, source, createdAt }. limit max 200, default 50; pass nextCursor back for the next page.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/feedback/submissions${tail}`,
    );
  },
};

// ─── Report flow ────────────────────────────────────────────────────────────

export const getReportFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_report_flow",
  description:
    "Read the published and draft report flow configs for an app. Report flows host a categorised bug/abuse/spam form (required category picker + message + optional reply email) at appmate.cloud/report/{appSlug}.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/report`,
    ),
};

export const updateReportDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_report_draft",
  description: [
    "Replace the draft report config. Body MUST be a full report config object (type: 'report').",
    "",
    "Shape:",
    "  {",
    "    type: 'report',",
    "    layout: 'steps' | 'single',  // optional, default 'steps' (multi-step: category, then message+email). 'single' = one screen.",
    "    intro: {",
    "      title, subtitle,",
    "      messagePlaceholder,           // textarea placeholder",
    "      submitLabel,",
    "      legal?                        // optional small print",
    "    },",
    "    categories: [                   // REQUIRED 1–10 entries",
    "      { id: 'bug',   label: 'Bug or crash',       emoji?: '🐞', hint?: '…' },",
    "      { id: 'abuse', label: 'Harassment or abuse', emoji?: '🚫' },",
    "      { id: 'spam',  label: 'Spam',                emoji?: '🧹' },",
    "      { id: 'privacy', label: 'Privacy concern',   emoji?: '🔒' },",
    "      { id: 'other', label: 'Something else',      emoji?: '💬' }",
    "    ],",
    "    emailField?: { enabled, placeholder?, required? },",
    "    success: { title, body, ctaLabel?, ctaUrl? },",
    "    hero?: { theme?, eyebrow?, accentColor?, titleFont? }",
    "  }",
    "",
    "Category ids must be snake_case ([a-z][a-z0-9_]*). The public submit endpoint validates posted category against this list — unknown ids return 422.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/report`,
      input.config,
    ),
};

export const publishReportFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_report_flow",
  description:
    "Promote the draft report config to the live published version. Visitors at appmate.cloud/report/{appSlug} see the new version immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/report/publish`,
    ),
};

export const listReportSubmissions: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_report_submissions",
  description:
    "Paginated list of report submissions for an app. Each row: { id, message, category, email, source, createdAt }. Pass `category` to scope to one bucket (e.g. 'bug') for triage.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    category: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    if (input.category) qs.set("category", input.category);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/report/submissions${tail}`,
    );
  },
};

// ─── Contact flow ───────────────────────────────────────────────────────────

export const getContactFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_contact_flow",
  description:
    "Read the published and draft contact flow configs for an app. Contact flows host a minimal inquiry form (optional name + required/optional email + optional message text) at appmate.cloud/contact/{appSlug}.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/contact`,
    ),
};

export const updateContactDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_contact_draft",
  description: [
    "Replace the draft contact config. Body MUST be a full contact config object (type: 'contact').",
    "",
    "Shape:",
    "  {",
    "    type: 'contact',",
    "    layout: 'steps' | 'single',  // optional, default 'steps' (multi-step: message, then name+email). 'single' = one screen.",
    "    intro: {",
    "      title, subtitle,",
    "      submitLabel,",
    "      legal?                        // optional small print under the form",
    "    },",
    "    nameField?: {                   // OPTIONAL name widget",
    "      enabled: boolean,",
    "      placeholder?: 'Your name',",
    "      required?: boolean",
    "    },",
    "    emailField?: {                  // OPTIONAL/REQUIRED email input",
    "      enabled: boolean,",
    "      placeholder?: 'you@example.com',",
    "      required?: boolean",
    "    },",
    "    messageField?: {                // OPTIONAL message textarea",
    "      enabled: boolean,",
    "      placeholder?: 'What is on your mind?',",
    "      required?: boolean",
    "    },",
    "    success: {",
    "      title, body,",
    "      ctaLabel?, ctaUrl?            // optional follow-up button pair",
    "    },",
    "    hero?: {                        // dynamic landing theme config",
    "      theme?: 'minimal' | 'gradient' | 'dark' | 'side_by_side',",
    "      eyebrow?, accentColor?, titleFont?",
    "    }",
    "  }",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/contact`,
      input.config,
    ),
};

export const publishContactFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_contact_flow",
  description:
    "Promote the draft contact config to the live published version. Visitors at appmate.cloud/contact/{appSlug} see the new version live immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/contact/publish`,
    ),
};

// ─── Link page (link-in-bio) ────────────────────────────────────────────────

export const getLinkPageFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_link_page_flow",
  description:
    "Read the published and draft link-page configs for an app. A link page is a shareable 'link-in-bio' page (app logo + title/description, a row of icon links, and a list of labeled links) at appmate.cloud/p/{appSlug} — drop it in an Instagram/TikTok bio.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/link-page`,
    ),
};

export const updateLinkPageDraft: ToolDef<typeof updateDraftInput> = {
  name: "update_link_page_draft",
  description: [
    "Replace the draft link-page config. Body MUST be a full link_page config object (type: 'link_page').",
    "",
    "Shape:",
    "  {",
    "    type: 'link_page',",
    "    header: { title, description? },     // logo comes from the app record",
    "    iconLinks: [                         // top row of compact icon buttons (<=6)",
    "      { icon: 'ri:instagram', label: 'Instagram', url: 'https://…' }   // icon = a brand 'ri:<key>' (instagram/tiktok/x/youtube/…), a lucide name (e.g. 'Globe'), or an emoji",
    "    ],",
    "    links: [                            // main list of labeled links (<=25)",
    "      { label: 'Download on the App Store', sublabel?: 'iPhone & iPad', url: 'https://…' }",
    "    ],",
    "    legal?: string,                     // small print at the bottom",
    "    hero?: {                            // visual treatment",
    "      theme?: 'minimal' | 'gradient' | 'dark' | 'side_by_side',",
    "      eyebrow?, accentColor?, titleFont?",
    "    }",
    "  }",
    "",
    "No submissions — a link page is a published, versioned page. Publish with publish_link_page_flow.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/link-page`,
      input.config,
    ),
};

export const publishLinkPageFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_link_page_flow",
  description:
    "Promote the draft link-page config to the live published version. Visitors at appmate.cloud/p/{appSlug} see the new version immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/link-page/publish`,
    ),
};

export const listContactSubmissions: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_contact_submissions",
  description:
    "Paginated list of contact submissions for an app. Each row: { id, name, email, message, source, country, createdAt }. limit max 200, default 50; pass nextCursor back for next page.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/contact/submissions${tail}`,
    );
  },
};

// ─── Onboarding flow (web-to-app funnel) ─────────────────────────────────────

export const getOnboardingFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_onboarding_flow",
  description:
    "Read the published and draft onboarding flow configs for an app. Onboarding flows are web-to-app funnels (intro → quiz/info/email-capture steps → App Store handoff) hosted at appmate.cloud/onboarding/{appSlug}. Answers + email are captured server-side; the iOS SDK recovers them on first launch via a claim token.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/onboarding`,
    ),
};

export const updateOnboardingDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_onboarding_draft",
  description: [
    "Replace the draft onboarding config. Body MUST be a full onboarding config object (type: 'onboarding').",
    "",
    "Shape:",
    "  {",
    "    type: 'onboarding',",
    "    intro: { title, subtitle, startLabel, eyebrow? },",
    "    steps: [                          // REQUIRED 1–20, ordered",
    "      // question step — pick one or several options",
    "      {",
    "        kind: 'question', id: 'goal',",
    "        prompt: 'What brings you here?', subtitle?: '…',",
    "        selectMode?: 'single' | 'multi',   // omit → single",
    "        autoAdvance?: true,                // single only: tap advances",
    "        required?: true,",
    "        options: [ { id: 'save_time', label: 'Save time', emoji?: '⚡' } ]",
    "      },",
    "      // info step — copy/image screen, no input",
    "      { kind: 'info', id: 'value', title: '…', body: '…', imageUrl?, continueLabel? },",
    "      // email_capture step — the lead-capture moment",
    "      {",
    "        kind: 'email_capture', id: 'email',",
    "        title: '…', subtitle?, placeholder?, submitLabel?,",
    "        required?: true,                 // omit → required",
    "        legal?: '…'",
    "      }",
    "    ],",
    "    handoff: {",
    "      title, body, ctaLabel,",
    "      appStoreUrl?,                     // App Store / TestFlight URL; omit → no button",
    "      legal?",
    "    },",
    "    hero?: { theme?, eyebrow?, accentColor?, titleFont? }",
    "  }",
    "",
    "Step + option ids must be snake_case ([a-z][a-z0-9_]*) and unique. The server returns { ok:true, warnings:[...] } — warnings flag a missing email_capture step, a handoff with no appStoreUrl, duplicate ids, etc. Treat warnings as advisory.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/onboarding`,
      input.config,
    ),
};

export const publishOnboardingFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_onboarding_flow",
  description:
    "Promote the draft onboarding config to the live published version. Visitors at appmate.cloud/onboarding/{appSlug} see the new funnel immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/onboarding/publish`,
    ),
};

export const listOnboardingSubmissions: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_onboarding_submissions",
  description:
    "Paginated list of completed onboarding funnels for an app. Each row: { id, answers, email, source, claimed, claimedAt, country, createdAt }. `claimed` is true once the install was matched back to the completion. limit max 200, default 50; pass nextCursor back for the next page.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/onboarding/submissions${tail}`,
    );
  },
};

export const exportOnboardingCsv: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "export_onboarding_csv",
  description:
    "Return all completed onboarding funnels for an app as a CSV string (header row + one row per completion, with email + answers JSON + claim status). Useful for hand-off to a spreadsheet or mail merge.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: async (input, cfg) => {
    const csv = await apiFetchText(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/onboarding/submissions.csv`,
    );
    return { csv };
  },
};

// ─── Referral flow ───────────────────────────────────────────────────────────

export const getReferralFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_referral_flow",
  description:
    "Read the published and draft referral program config for an app. Referral is a share-with-a-friend loop: each user gets a link (appmate.cloud/r/{code}) AND a short human-readable code (e.g. K7Q4-R9XP); a friend who taps the link or types the code, then installs, triggers a reward for both sides. Codes + the referral graph live server-side; the iOS SDK mints links/codes, attributes installs on first launch (clipboard handoff) or via a typed code, and reports rewards owed.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/referral`,
    ),
};

export const updateReferralDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_referral_draft",
  description: [
    "Replace the draft referral config. Body MUST be a full referral config object (type: 'referral').",
    "",
    "Shape:",
    "  {",
    "    type: 'referral',",
    "    landing: {                        // the invite page a friend sees at /r/{code}",
    "      eyebrow?, title, subtitle, ctaLabel,",
    "      appStoreUrl?,                    // REQUIRED before go-live — the install button target",
    "      fallback?: 'app_store' | 'website',  // where a not-installed friend goes (default app_store; 'website' uses the app's websiteUrl)",
    "      legal?",
    "    },",
    "    share: { messageTemplate },        // the referrer's share text; the link is appended automatically",
    "    rewards: {",
    "      referrerWeeks: 1,                // free weeks the referrer earns per installed friend (1–8)",
    "      refereeEnabled: true,            // also reward the NEW user on install?",
    "      refereeWeeks?: 1,                // required when refereeEnabled (1–8)",
    "      referrerLabel?, refereeLabel?    // human copy shown on the landing + returned to the SDK",
    "    },",
    "    maxRewardsPerReferrer?: 10         // lifetime cap per referrer; 0/omit = unlimited (farming risk)",
    "  }",
    "",
    "Reward trigger is the friend's INSTALL (attributed on first launch). The server returns { ok:true, warnings:[...] } — warnings flag a missing/placeholder appStoreUrl, refereeEnabled without refereeWeeks, and an absent cap. Treat warnings as advisory but fix them before publishing.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/referral`,
      input.config,
    ),
};

export const publishReferralFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_referral_flow",
  description:
    "Promote the draft referral config to the live published version. New share links + the invite landing use the new config immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/referral/publish`,
    ),
};

export const listReferrals: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    status: z.ZodOptional<z.ZodEnum<["pending", "attributed", "expired"]>>;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_referrals",
  description:
    "Paginated list of referrals for an app. Each row: { id, code, referrerUserId, status, source, refereeUserId, attributedAt, referrerRewarded, refereeRewarded, country, createdAt }. status='attributed' means the friend installed; source is 'link' (tapped share link) or 'code' (typed the referrer's code). Optional `status` filter; limit max 200, default 50.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    status: z.enum(["pending", "attributed", "expired"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.status) qs.set("status", input.status);
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/referrals${tail}`,
    );
  },
};

export const exportReferralsCsv: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "export_referrals_csv",
  description:
    "Return the full referral graph for an app as a CSV string (one row per invite, with code, status, source (link/typed-code), referee, and reward flags).",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: async (input, cfg) => {
    const csv = await apiFetchText(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/referrals.csv`,
    );
    return { csv };
  },
};

// ─── Wishlist flow (feature-request board) ──────────────────────────────────
//
// Unlike every other flow (write-only), the wishlist is an INTERACTIVE board:
// ideas are read back, upvoted, commented on, and moderated. Beyond the usual
// get/update/publish trio it exposes moderation tools (set status, delete idea,
// reply, delete comment) — the first MUTATING admin tools in the set.

export const getWishlistFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_wishlist_flow",
  description:
    "Read the published and draft wishlist (feature-request board) configs for an app. The board lives at appmate.cloud/wishlist/{appSlug}; visitors submit ideas, upvote, and comment, and the owner moderates status.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/wishlist`,
    ),
};

export const updateWishlistDraft: ToolDef<typeof updateDraftInput> = {
  name: "update_wishlist_draft",
  description: [
    "Replace the draft wishlist config. Body MUST be a full wishlist config object (type: 'wishlist').",
    "",
    "Shape:",
    "  {",
    "    type: 'wishlist',",
    "    intro: { title, subtitle, submitLabel, legal? },",
    "    identity?: {                     // who can participate + vote dedup",
    "      mode: 'anonymous' | 'email',   // default 'anonymous' (dedup by cookie+IP)",
    "      requireEmailToSubmit?, requireEmailToVote?, requireEmailToComment?  // email mode only",
    "    },",
    "    categories?: [                   // OPTIONAL tags (0–12)",
    "      { id: 'feature', label: 'New feature', emoji?: '✨', hint?: '…' }",
    "    ],",
    "    statusLabels?: {                 // rename lifecycle stages on the board",
    "      open?, planned?, in_progress?, done?, declined?",
    "    },",
    "    submitForm?: { titlePlaceholder?, bodyPlaceholder? },",
    "    moderation?: { autoApprove?: false },  // false (default) = new ideas start pending/hidden",
    "    success: { title, body, ctaLabel?, ctaUrl? },",
    "    hero?: { theme?, eyebrow?, accentColor?, titleFont? }",
    "  }",
    "",
    "Server returns { ok:true, warnings: [] }.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/wishlist`,
      input.config,
    ),
};

export const publishWishlistFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_wishlist_flow",
  description:
    "Promote the draft wishlist config to the live published version. Visitors at appmate.cloud/wishlist/{appSlug} see the new version immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/wishlist/publish`,
    ),
};

export const listWishlistIdeas: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    status: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    sort: z.ZodOptional<z.ZodEnum<["votes", "new"]>>;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_wishlist_ideas",
  description:
    "Paginated list of wishlist ideas for an app — ALL statuses (including pending review). Each row: { id, title, body, category, status, voteCount, commentCount, pinned, author, email, source, country, createdAt }. Optional status ('pending'|'open'|'planned'|'in_progress'|'done'|'declined') + category filters; sort 'votes' (default 'new'). limit max 200, default 50; pass nextCursor back for the next page.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    status: z.string().optional(),
    category: z.string().optional(),
    sort: z.enum(["votes", "new"]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.status) qs.set("status", input.status);
    if (input.category) qs.set("category", input.category);
    if (input.sort) qs.set("sort", input.sort);
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas${tail}`,
    );
  },
};

export const setWishlistIdeaStatus: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    ideaId: z.ZodString;
    status: z.ZodEnum<["pending", "open", "planned", "in_progress", "done", "declined"]>;
    pinned: z.ZodOptional<z.ZodBoolean>;
  }>
> = {
  name: "set_wishlist_idea_status",
  description:
    "Moderate an idea: set its status and/or pin it. 'pending' hides it from the public board; 'open' approves it. Statuses: pending | open | planned | in_progress | done | declined.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    ideaId: z.string().min(1),
    status: z.enum(["pending", "open", "planned", "in_progress", "done", "declined"]),
    pinned: z.boolean().optional(),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PATCH",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas/${encodeURIComponent(input.ideaId)}`,
      { status: input.status, ...(input.pinned !== undefined ? { pinned: input.pinned } : {}) },
    ),
};

export const deleteWishlistIdea: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString; ideaId: z.ZodString }>
> = {
  name: "delete_wishlist_idea",
  description:
    "Permanently delete an idea AND all of its votes and comments. IRREVERSIBLE — there is no undo. Prefer set_wishlist_idea_status with 'declined' to reject an idea while keeping it (and the decision) visible.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    ideaId: z.string().min(1),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "DELETE",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas/${encodeURIComponent(input.ideaId)}`,
    ),
};

export const listWishlistComments: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    ideaId: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_wishlist_comments",
  description:
    "Paginated comments on an idea (oldest-first, excludes deleted). Each row: { id, body, author, isOwner, isOfficial, createdAt }. limit max 200, default 50; pass nextCursor back for more.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    ideaId: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas/${encodeURIComponent(input.ideaId)}/comments${tail}`,
    );
  },
};

export const postWishlistComment: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    ideaId: z.ZodString;
    body: z.ZodString;
    official: z.ZodOptional<z.ZodBoolean>;
  }>
> = {
  name: "post_wishlist_comment",
  description:
    "Post an OWNER reply on an idea (shown with a Team badge). Set official:true to mark it an authoritative response. Use this to answer or expand on a user's idea.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    ideaId: z.string().min(1),
    body: z.string().min(1).max(2000),
    official: z.boolean().optional(),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas/${encodeURIComponent(input.ideaId)}/comments`,
      { body: input.body, official: input.official ?? false },
    ),
};

export const deleteWishlistComment: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString; commentId: z.ZodString }>
> = {
  name: "delete_wishlist_comment",
  description:
    "Soft-delete a comment (hidden from the public board, thread continuity preserved). Use for moderation.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    commentId: z.string().min(1),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "DELETE",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/comments/${encodeURIComponent(input.commentId)}`,
    ),
};

export const exportWishlistCsv: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "export_wishlist_csv",
  description:
    "Return all wishlist ideas for an app as a CSV string (one row per idea, every status: created_at, status, title, votes, comments, category, email, author, country, body).",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: async (input, cfg) => {
    const csv = await apiFetchText(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas.csv`,
    );
    return { csv };
  },
};

// Registered alphabetically so `list_tools` reads predictably.
export const ALL_TOOLS = [
  createApp,
  deleteWishlistComment,
  deleteWishlistIdea,
  exportOnboardingCsv,
  exportReferralsCsv,
  exportWaitlistCsv,
  exportWishlistCsv,
  getApp,
  getCancelFlow,
  getContactFlow,
  getFeedbackFlow,
  getLinkPageFlow,
  getOnboardingFlow,
  getReferralFlow,
  getReportFlow,
  getWaitlistFlow,
  getWishlistFlow,
  listApps,
  listContactSubmissions,
  listFeedbackSubmissions,
  listOnboardingSubmissions,
  listReferrals,
  listReportSubmissions,
  listWaitlistSignups,
  listWishlistComments,
  listWishlistIdeas,
  postWishlistComment,
  publishCancelFlow,
  publishContactFlow,
  publishFeedbackFlow,
  publishLinkPageFlow,
  publishOnboardingFlow,
  publishReferralFlow,
  publishReportFlow,
  publishWaitlistFlow,
  publishWishlistFlow,
  setWishlistIdeaStatus,
  updateCancelDraft,
  updateContactDraft,
  updateFeedbackDraft,
  updateLinkPageDraft,
  updateOnboardingDraft,
  updateReferralDraft,
  updateReportDraft,
  updateWaitlistDraft,
  updateWishlistDraft,
] as const;

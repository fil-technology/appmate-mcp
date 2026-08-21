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

// cancel + waitlist support MULTIPLE flows per app (a primary + secondaries).
// `flowSlug` targets a secondary (omit = primary); a fresh slug creates one.
// The other flow types are one-per-app and ignore it.
const multiFlowInput = z.object({
  appIdOrSlug: z.string().min(1),
  flowSlug: z
    .string()
    .optional()
    .describe(
      "cancel/waitlist only — target a secondary flow by slug (omit for the primary; a new slug creates one). Call list_flows to see existing slugs.",
    ),
});
const updateMultiDraftInput = updateDraftInput.extend({
  flowSlug: multiFlowInput.shape.flowSlug,
});

// Build a /flows/{type} path with an optional ?flowSlug and sub-path (/publish).
function flowPath(
  appIdOrSlug: string,
  type: string,
  flowSlug?: string,
  suffix = "",
): string {
  const base = `/api/v1/apps/${encodeURIComponent(appIdOrSlug)}/flows/${type}${suffix}`;
  return flowSlug ? `${base}?flowSlug=${encodeURIComponent(flowSlug)}` : base;
}

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

export const getCancelFlow: ToolDef<typeof multiFlowInput> = {
  name: "get_cancel_flow",
  description:
    "Read the published and draft cancel flow configs. An app can have MULTIPLE cancel flows — pass flowSlug for a secondary (omit for the primary); call list_flows to see existing slugs.",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(cfg, "GET", flowPath(input.appIdOrSlug, "cancel", input.flowSlug)),
};

// `config` is the full flow-config object (advertised as type:object via
// updateDraftInput so hosts pass structured JSON). The server holds the
// canonical Zod schema: it returns 422 with paths on validation errors AND a
// `warnings` array on success for soft mismatches (e.g. showThanksScreen + a
// "Contact support" label).
export const updateCancelDraft: ToolDef<
  typeof updateMultiDraftInput
> = {
  name: "update_cancel_draft",
  description: [
    "Replace the draft cancel flow config. Body MUST be a full cancel config object (type: 'cancel'). An app can have MULTIPLE cancel flows — pass flowSlug to target/create a secondary (omit for the primary; list_flows shows existing ones).",
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
  inputSchema: updateMultiDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      flowPath(input.appIdOrSlug, "cancel", input.flowSlug),
      input.config,
    ),
};

export const publishCancelFlow: ToolDef<typeof multiFlowInput> = {
  name: "publish_cancel_flow",
  description:
    "Promote the draft cancel config to the live published version. The live cancel URL flips on success. Pass flowSlug to publish a secondary cancel flow (omit for the primary). ALWAYS review the warnings array returned from the most recent update_cancel_draft call and fix any reported issues BEFORE publishing — publishing locks the broken flow in front of real users.",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      flowPath(input.appIdOrSlug, "cancel", input.flowSlug, "/publish"),
    ),
};

// ─── Waitlist flow ──────────────────────────────────────────────────────────

export const getWaitlistFlow: ToolDef<typeof multiFlowInput> = {
  name: "get_waitlist_flow",
  description:
    "Read the published and draft waitlist flow configs. An app can have MULTIPLE waitlists — pass flowSlug for a secondary (omit for the primary); call list_flows to see existing slugs.",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(cfg, "GET", flowPath(input.appIdOrSlug, "waitlist", input.flowSlug)),
};

export const updateWaitlistDraft: ToolDef<
  typeof updateMultiDraftInput
> = {
  name: "update_waitlist_draft",
  description: [
    "Replace the draft waitlist config. Body MUST be a full waitlist config object (type: 'waitlist'). An app can have MULTIPLE waitlists — pass flowSlug to target/create a secondary (omit for the primary; list_flows shows existing ones).",
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
    "    fields?: [              // 0–8 extra fields collected with the email;",
    "                           // answers land on each signup's attributesJson + CSV.",
    "      { id: 'twitter', label: 'X / Twitter', type: 'text', placeholder?: '@handle', required?: false },",
    "      { id: 'runs_server', label: 'Running a server?', type: 'boolean', required?: false },",
    "      { id: 'use_case', label: 'Use case?', type: 'select', options: ['Personal','Startup'], required?: false }",
    "    ],",
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
    "  private_beta, early_access_referral, beta_qualify (custom fields).",
    "",
    "Server returns { ok:true, warnings: [...] } — check warnings before publishing.",
    "Common warnings: partial_cta (label without url, or vice versa).",
  ].join("\n"),
  inputSchema: updateMultiDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      flowPath(input.appIdOrSlug, "waitlist", input.flowSlug),
      input.config,
    ),
};

export const publishWaitlistFlow: ToolDef<typeof multiFlowInput> = {
  name: "publish_waitlist_flow",
  description:
    "Promote the draft waitlist config to the live published version. Pass flowSlug to publish a secondary waitlist (omit for the primary).",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      flowPath(input.appIdOrSlug, "waitlist", input.flowSlug, "/publish"),
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
    "Paginated list of waitlist signups for an app. Each row: { id, email, source, country, area, approxLat, approxLon, geohash, locale, platform, appVersion, userAgent, createdAt }. `area` + the approximate coordinates (rounded ~1.1 km) / geohash are present only on programmatic (SDK) signups — use them to rank demand per city for a location-based launch. Returns up to `limit` rows (max 200, default 50) and a `nextCursor` for the next page.",
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

// ─── Crash flow ─────────────────────────────────────────────────────────────

export const getCrashFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_crash_flow",
  description:
    "Read the published and draft crash flow configs for an app. Crash flows host a crash-report form (message + optional paste-a-log field + optional reply email) at appmate.cloud/crash/{appSlug}; the iOS/macOS SDK submits to the same flow with structured diagnostics (exception, stack trace, device/OS/app versions) attached.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/crash`,
    ),
};

export const updateCrashDraft: ToolDef<
  typeof updateDraftInput
> = {
  name: "update_crash_draft",
  description: [
    "Replace the draft crash flow config. Body MUST be a full crash config object (type: 'crash').",
    "",
    "Shape:",
    "  {",
    "    type: 'crash',",
    "    intro: {",
    "      title, subtitle,",
    "      messagePlaceholder,           // 'what happened?' textarea placeholder",
    "      submitLabel,",
    "      legal?                        // optional small print",
    "    },",
    "    logField?: { enabled, label?, placeholder? },  // hosted-page-only 'paste a crash log' textarea; SDK reports send structured diagnostics instead",
    "    emailField?: { enabled, placeholder?, required? },",
    "    success: { title, body, ctaLabel?, ctaUrl? },",
    "    hero?: { theme?, eyebrow?, accentColor?, titleFont? }",
    "  }",
    "",
    "No categories and no layout field — crash forms are single-screen. Diagnostics (exceptionName, stackTrace, osVersion, deviceModel, appVersion, …) are submission-side data sent by the SDK, not config.",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/crash`,
      input.config,
    ),
};

export const publishCrashFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_crash_flow",
  description:
    "Promote the draft crash flow config to the live published version. Visitors at appmate.cloud/crash/{appSlug} (and SDK clients) see the new version immediately.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/crash/publish`,
    ),
};

export const listCrashSubmissions: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<z.ZodEnum<["new", "reviewed", "resolved"]>>;
  }>
> = {
  name: "list_crash_submissions",
  description:
    "Paginated list of crash reports for an app. Each row: { id, message, status, reviewedAt, exceptionName, exceptionReason, stackTrace, platform, osVersion, deviceModel, appVersion, buildNumber, crashedAt, metadata, attachments, email, source, country, userAgent, createdAt }. `attachments` is an array of { name, content } text logs the SDK attached (console output, breadcrumbs, a log file). Pass `status` ('new' | 'reviewed' | 'resolved') to scope to one triage bucket — e.g. status:'new' for everything still awaiting review.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().optional(),
    status: z.enum(["new", "reviewed", "resolved"]).optional(),
  }),
  handler: (input, cfg) => {
    const qs = new URLSearchParams();
    if (input.limit !== undefined) qs.set("limit", String(input.limit));
    if (input.cursor) qs.set("cursor", input.cursor);
    if (input.status) qs.set("status", input.status);
    const tail = qs.toString() ? `?${qs.toString()}` : "";
    return apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/crash/submissions${tail}`,
    );
  },
};

export const setCrashReportStatus: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    submissionId: z.ZodString;
    status: z.ZodEnum<["new", "reviewed", "resolved"]>;
  }>
> = {
  name: "set_crash_report_status",
  description:
    "Move a crash report through triage: 'new' (untriaged) → 'reviewed' (seen/acknowledged) → 'resolved' (fixed or won't-fix). Setting 'new' clears reviewedAt; any other status stamps it. Get submission ids from list_crash_submissions.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    submissionId: z.string().min(1),
    status: z.enum(["new", "reviewed", "resolved"]),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PATCH",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/crash/submissions/${encodeURIComponent(input.submissionId)}`,
      { status: input.status },
    ),
};

// ─── App promotion (cross-app promotion) flow ───────────────────────────────
// A source app promotes one (single) or many (rotating) destination apps
// already in the same account. No hosted web page, no submissions — the SDK
// requests a placement and the backend returns a decision (Slice 3+). These
// tools manage the flow DEFINITION only. Multi-flow: one flow per placement,
// so they take flowSlug like cancel/waitlist.

export const getAppPromotionFlow: ToolDef<typeof multiFlowInput> = {
  name: "get_app_promotion_flow",
  description:
    "Read the published and draft cross-app promotion (app_promotion) config for an app. A promotion promotes OTHER apps in the same account as destinations. An app can have MULTIPLE promotion flows — one per placement — so pass flowSlug for a specific one (omit for the default 'promotion'); call list_flows to see slugs.",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      flowPath(input.appIdOrSlug, "app-promotion", input.flowSlug),
    ),
};

export const updateAppPromotionDraft: ToolDef<typeof updateMultiDraftInput> = {
  name: "update_app_promotion_draft",
  description: [
    "Replace the draft cross-app promotion config. Body MUST be a full config object (type: 'app_promotion'). Multi-flow — pass flowSlug to target/create a specific placement (omit for the default 'promotion').",
    "",
    "Shape:",
    "  {",
    "    type: 'app_promotion',",
    "    placement,                       // snake_case product moment the SDK requests, e.g. 'cleaning_completed'",
    "    mode: 'single' | 'rotating',",
    "    rotationStrategy?: 'smart' | 'even' | 'weighted',   // default 'smart'",
    "    presentation: 'apple_native' | 'custom_card_then_apple_native' | 'store_product_page',",
    "    destinations: [{",
    "      destinationAppId,              // an App in THIS account (id) to promote",
    "      enabled?, priority?, weight?,  // weight ⇒ weighted rotation",
    "      startAt?, endAt?,              // ISO availability window",
    "      countries?, languages?,        // per-destination targeting overrides",
    "      maxImpressions?, cooldownDays?,",
    "      content?: { headline?, body?, cta?, artworkUrl? },",
    "      localizations?: { [locale]: { headline?, body?, cta?, artworkUrl? } },",
    "      installedAction?: { type: 'open_home'|'named_destination'|'universal_link'|'custom_scheme'|'none', destinationKey?, universalUrl?, customSchemeUrl?, fallback?, webFallbackUrl? },",
    "      notInstalledAction?: { type: 'sk_overlay'|'store_product_page'|'app_store_url' },",
    "      deferredAction?: { enabled, route?, expiresAfterHours?, fallbackRoute?, minAppVersion? }",
    "    }],",
    "    defaultInstalledAction?, defaultNotInstalledAction?,   // applied when a destination omits its own",
    "    targeting?: { platforms?, countries?, languages?, minAppVersion?, maxAppVersion?, startAt?, endAt? },",
    "    frequency?: { cooldownDays?, lifetimeImpressions?, avoidImmediateRepeat? },   // defaults 14 / 4 / true",
    "    defaultLocale?, card?: { dismissLabel?, ctaLabel? }",
    "  }",
    "",
    "Destination apps come from the same AppMate account and expose reusable metadata (App Store id/URL, universalLinkBase, named deepLinkDestinations) on the App itself — you don't re-enter it here, you reference destinationAppId. named_destination.destinationKey must be a key from that app's deepLinkDestinations.",
  ].join("\n"),
  inputSchema: updateMultiDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      flowPath(input.appIdOrSlug, "app-promotion", input.flowSlug),
      input.config,
    ),
};

export const publishAppPromotionFlow: ToolDef<typeof multiFlowInput> = {
  name: "publish_app_promotion_flow",
  description:
    "Promote the draft cross-app promotion config to the live published version. SDK placement requests resolve against the new version immediately. Pass flowSlug to publish a specific placement (omit for the default 'promotion').",
  inputSchema: multiFlowInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      flowPath(input.appIdOrSlug, "app-promotion", input.flowSlug, "/publish"),
    ),
};

// ─── Legal flow (privacy policy + terms) ────────────────────────────────────
// Composes hosted privacy + terms pages from STRUCTURED facts (not free text),
// so the page is correct by construction. NOT legal advice — it generates a
// document from facts the owner asserts. Served at appmate.cloud/legal/{appSlug}
// (privacy) + /legal/{appSlug}/terms; published versions are immutable + dated.

export const getLegalFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_legal_flow",
  description:
    "Read the published + draft legal (privacy policy + terms) config for an app, plus the public URLs. The page is composed from structured facts (entity, processors, declarations, platform capabilities) — not free text.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/legal`,
    ),
};

export const updateLegalDraft: ToolDef<typeof updateDraftInput> = {
  name: "update_legal_draft",
  description: [
    "Replace the draft legal config. Body MUST be a full config object (type: 'legal'). This produces a privacy policy + terms from FACTS — it is NOT legal advice, and must not be presented as such. AppMate never infers processors; the owner states them.",
    "",
    "Shape:",
    "  {",
    "    type: 'legal',",
    "    entity: { name, contactEmail?, jurisdiction? },",
    "    effectiveDate?: 'YYYY-MM-DD',           // stamped to today on publish if omitted",
    "    localData?: { enabled, items: [ '…what never leaves the device' ] },",
    "    processors: [ { id, purpose?, receives?, name?, privacyUrl? } ],  // id = preset or custom slug",
    "    platformData?: { healthkit?: {read,write}, notifications?: 'local'|'push', icloud?, location?: 'none'|'whenInUse'|'always', camera?, photos?, contacts?, microphone? },",
    "    declarations: { sellsData, advertising, analytics, tracking, profiling },   // the negative claims",
    "    childrenDirected?, medicalDisclaimer?,",
    "    terms?: { enabled, appleStandardEula?, customClauses?: [ {heading, body} ] },",
    "    locales?, hero?",
    "  }",
    "",
    "Known processor presets (name the id; purpose/receives fill in automatically): revenuecat, superwall, firebase, amplitude, posthog, sentry, mixpanel, appmate. On-device-only capabilities (local storage, on-device HealthKit/location) are NOT 'collection'. Returns { ok, warnings } — heed the warnings (missing contactEmail, unknown processor id, a cancel flow but no processors, future effectiveDate).",
  ].join("\n"),
  inputSchema: updateDraftInput,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/legal`,
      input.config,
    ),
};

export const publishLegalFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_legal_flow",
  description:
    "Publish the draft legal policy. Stamps the effective date to today, freezes this version immutably (prior versions stay at /legal/{appSlug}/v/{n}), and returns both public URLs { privacy, terms }. A published page is never silently rewritten.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/legal/publish`,
    ),
};

export const getAppStorePrivacyDeclaration: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_app_store_privacy_declaration",
  description:
    "Derive the App Store 'App Privacy' nutrition label from the legal config — the exact answers for App Store Connect's questionnaire. Returns { basis, dataNotCollected, entries: [{category, purpose, linkedToIdentity, usedForTracking, source}], unmappedProcessors }. Each entry names the processor that caused it. Prevents a common false declaration: 'Data Not Collected' while a purchases SDK is linked. Only data that leaves the device counts.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/legal/app-store-privacy`,
    ),
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

export const replyToContactSubmission: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    submissionId: z.ZodString;
    subject: z.ZodString;
    body: z.ZodString;
  }>
> = {
  name: "reply_to_contact_submission",
  description:
    "Send a branded email reply to a contact submission, from AppMate. The email is sent from the app-branded AppMate address; Reply-To is the app's support email (or the account email) so the person's reply reaches a real inbox. Counts against the daily email quota. Get submission ids + the sender's name/email from list_contact_submissions. Pass FINAL text — tokens are not substituted here. Returns { ok, mode } (mode 'logged' means no email provider is configured, but the reply was recorded).",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    submissionId: z.string().min(1),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(8000),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/contact/submissions/${encodeURIComponent(input.submissionId)}/reply`,
      { subject: input.subject, body: input.body },
    ),
};

// ─── Onboarding flow (web-to-app funnel) ─────────────────────────────────────

export const getOnboardingFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_onboarding_flow",
  description:
    "Read the published and draft onboarding flow configs for an app. Onboarding flows are web-to-app funnels (intro → quiz/info/email-capture steps → App Store handoff) hosted at appmate.cloud/onboarding/{appSlug}. Answers + email are captured server-side; the iOS/macOS SDK recovers them on first launch via a claim token.",
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
    "Read the published and draft referral program config for an app. Referral is a share-with-a-friend loop: each user gets a link (appmate.cloud/r/{code}) AND a short human-readable code (e.g. K7Q4-R9XP); a friend who taps the link or types the code, then installs, triggers a reward for both sides. Codes + the referral graph live server-side; the iOS/macOS SDK mints links/codes, attributes installs on first launch (clipboard handoff) or via a typed code, and reports rewards owed. Optional anti-abuse caps: maxRewardsPerReferrer caps rewards earned per referrer; maxInvitesPerReferrer caps how many people one referrer can invite (once reached, new friends still install but aren't credited). Both are optional — 0 or omitted = unlimited.",
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
    "      referrer: { amount: 1, unit: 'week' },   // what the referrer earns per installed friend. unit 'week' = free weeks (amount 1–8, mapped to trial time); any other unit is an app-defined currency you grant by amount, e.g. { amount: 100, unit: 'drop', unitPlural: 'drops' }",
    "      refereeEnabled: true,            // also reward the NEW user on install?",
    "      referee?: { amount: 1, unit: 'week' },    // required when refereeEnabled; same shape as referrer",
    "      referrerLabel?, refereeLabel?    // human copy shown on the landing + returned to the SDK",
    "    },",
    "    maxRewardsPerReferrer?: 10         // lifetime cap per referrer; 0/omit = unlimited (farming risk)",
    "  }",
    "",
    "Legacy { referrerWeeks, refereeWeeks } is still accepted and auto-upgraded to { amount, unit: 'week' }.",
    "Reward trigger is the friend's INSTALL (attributed on first launch). The server returns { ok:true, warnings:[...] } — warnings flag a missing/placeholder appStoreUrl, refereeEnabled without a referee reward, a custom (non-week) unit (clients on a weeks-only SDK receive weeks:0), and an absent cap. Treat warnings as advisory but fix them before publishing.",
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
    "Read the published and draft wishlist (feature-request board) configs for an app. The board lives at appmate.cloud/wishlist/{appSlug}; visitors submit ideas, upvote, and comment, and the owner moderates status. NOTE for iOS apps: present the board NATIVELY via the SDK (RetentionFlow.presentWishlist(userId:) or the WishlistView screen) — do NOT link or web-view appmate.cloud/wishlist/{appSlug} inside the app. The hosted page + embed are for websites. These MCP tools configure the same flow regardless of how it's surfaced.",
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
    "Promote the draft wishlist config to the live published version. Visitors at appmate.cloud/wishlist/{appSlug} see the new version immediately. For an iOS app, surface the board natively with the SDK (RetentionFlow.presentWishlist(userId:) / WishlistView) rather than linking this URL.",
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

export const createWishlistIdea: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    title: z.ZodString;
    body: z.ZodOptional<z.ZodString>;
    category: z.ZodOptional<z.ZodString>;
    status: z.ZodOptional<
      z.ZodEnum<["pending", "open", "planned", "in_progress", "done", "declined"]>
    >;
  }>
> = {
  name: "create_wishlist_idea",
  description:
    "Seed an idea onto the board as the app owner (so it isn't empty for early visitors — they can then upvote/comment). Defaults to status 'open' (visible). Use a category id from the flow config when set.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    title: z.string().min(1).max(120),
    body: z.string().max(4000).optional(),
    category: z.string().optional(),
    status: z
      .enum(["pending", "open", "planned", "in_progress", "done", "declined"])
      .optional(),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/wishlist/ideas`,
      {
        title: input.title,
        body: input.body,
        category: input.category,
        status: input.status,
      },
    ),
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
// ── QR codes ──────────────────────────────────────────────────────────────

// Derive the public apex host (where /api/public/qr is canonical) from the API
// base URL by dropping a leading flow./cancel./signup. label.
function qrPublicBase(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    u.hostname = u.hostname.replace(/^(flow|cancel|signup)\./, "");
    return u.origin;
  } catch {
    return baseUrl.replace(/\/$/, "");
  }
}

const qrInput = z.object({
  appIdOrSlug: z.string().min(1).describe("The app's cuid id or slug."),
  flow: z
    .enum([
      "cancel",
      "waitlist",
      "feedback",
      "report",
      "crash",
      "contact",
      "onboarding",
      "wishlist",
      "link",
      "referral",
    ])
    .describe("Which flow's public page the QR should open."),
  theme: z
    .enum(["auto", "light", "dark"])
    .optional()
    .describe("QR colour scheme. Default 'auto' matches the flow's colorScheme."),
  referralCode: z
    .string()
    .optional()
    .describe(
      "For flow='referral', a referrer's code so the QR encodes that specific invite link.",
    ),
});

export const getQrCode: ToolDef<typeof qrInput> = {
  name: "get_qr_code",
  description:
    "Get shareable QR-code image URLs for a flow's public page, with the app's logo centred (rounded 'dots' style). Returns public, no-auth PNG + SVG URLs — PNG for print/raster, SVG for vector. Theme defaults to the flow's color scheme (override with light/dark). For flow='referral', pass referralCode to encode a specific invite link. The same images back the dashboard download/copy and the iOS/macOS SDK (RetentionFlow.qrCode / RetentionFlowQRView).",
  inputSchema: qrInput,
  handler: async (input, cfg) => {
    const app = await apiFetch<{ slug?: string; app?: { slug?: string } }>(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}`,
    );
    const slug = app.slug ?? app.app?.slug ?? input.appIdOrSlug;
    const params = new URLSearchParams();
    if (input.theme && input.theme !== "auto") params.set("theme", input.theme);
    if (input.referralCode) params.set("code", input.referralCode);
    const extra = params.toString() ? `&${params.toString()}` : "";
    const base = `${qrPublicBase(cfg.baseUrl)}/api/public/qr/${encodeURIComponent(slug)}/${input.flow}`;
    return {
      app: slug,
      flow: input.flow,
      pngUrl: `${base}?format=png&size=1024${extra}`,
      svgUrl: `${base}?format=svg${extra}`,
      note: "Public image URLs (no auth). Embed or share directly. The QR encodes the flow's public page and centres the app logo.",
    };
  },
};

export const listFlows: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString; type: z.ZodOptional<z.ZodString> }>
> = {
  name: "list_flows",
  description:
    "List every flow for an app: id, type, slug, name, status, isPrimary. cancel + waitlist can have MULTIPLE flows per app (the primary plus secondaries at /{appSlug}/{slug}); all other types are one per app. Pass a returned slug as flowSlug on get_/update_/publish_{cancel,waitlist} to target a specific one. Optional `type` filters (e.g. 'waitlist').",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    type: z.string().optional(),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows${input.type ? `?type=${encodeURIComponent(input.type)}` : ""}`,
    ),
};

// ─── Short links ────────────────────────────────────────────────────────────
//
// Short links are NOT a flow: there's no draft/publish cycle, no config blob.
// They're plain records — create one and it redirects immediately. Every path
// segment accepts the link's cuid OR its short code, because an agent almost
// always has the code (it's the shareable part) rather than the id.

// Shared blurb so every short-link tool teaches the same model of the feature
// without each description having to re-derive it.
const SHORT_LINK_PRIMER = [
  "How a short link resolves: `url` is the FALLBACK and is always required — it's where desktop, unknown platforms, and any platform without an override go. `iosUrl` and `androidUrl` are optional per-platform overrides picked from the visitor's user-agent; leave one empty and that platform falls back to `url`. Deep links (myapp://…) are valid destinations, not just https.",
  "Expiry is two INDEPENDENT limits and you can set either, both, or neither: `expiresAt` (a date) and `maxClicks` (a click budget). Whichever trips first ends the link. When it ends, `expiredBehavior` decides what a visitor sees — 'page' shows a branded 'link ended' page (customise with `expiredMessage`), 'redirect' sends them to `expiredUrl` instead.",
  "Every response carries a derived `state`: 'active' (redirecting now), 'disabled' (turned off by hand), 'expired' (past expiresAt), or 'limit_reached' (hit maxClicks). `state` is computed, not stored — a link with status 'active' can still report 'expired'.",
].join("\n");

const shortLinkRef = z.object({
  appIdOrSlug: z.string().min(1).describe("The app's cuid id or slug."),
  linkIdOrCode: z
    .string()
    .min(1)
    .describe(
      "The link's cuid id OR its short code (e.g. 'summer-sale' or 'k7q4rp') — either works.",
    ),
});

export const listShortLinks: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "list_short_links",
  description: [
    "Paginated list of an app's short links, newest first. Each row: { id, code, shortUrl, name, url, iosUrl, androidUrl, status, state, expiresAt, maxClicks, clickCount, expiredBehavior, expiredUrl, expiredMessage, createdAt, updatedAt }. limit max 200, default 50; pass the returned `nextCursor` back for the next page.",
    "",
    "`shortUrl` is the ready-to-share URL — hand that to the user, not the raw code. `clickCount` here is the running total used for the click limit; call get_short_link for the click breakdown by platform and country.",
    "",
    SHORT_LINK_PRIMER,
  ].join("\n"),
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
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/links${tail}`,
    );
  },
};

export const getShortLink: ToolDef<typeof shortLinkRef> = {
  name: "get_short_link",
  description: [
    "Fetch one short link plus its click analytics. Returns { link, stats }.",
    "",
    "stats = {",
    "  clicks,        // total REAL clicks (bots excluded)",
    "  byTarget,      // { ios, android, fallback, expired } — which destination each click resolved to",
    "  topCountries,  // up to 10 × { country, clicks }, real clicks only",
    "  botClicks      // link-preview fetchers (Slack, WhatsApp, iMessage, Facebook…) that unfurled the URL",
    "}",
    "",
    "IMPORTANT when reporting numbers: `botClicks` are NOT people. They're counted separately, are never added to `clicks` or `byTarget`, and never burn the link's click limit. A link posted in a group chat can show a large botClicks with zero real clicks — don't present that as engagement. A high `byTarget.expired` means people are still tapping a link that has already ended.",
    "",
    SHORT_LINK_PRIMER,
  ].join("\n"),
  inputSchema: shortLinkRef,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/links/${encodeURIComponent(input.linkIdOrCode)}`,
    ),
};

export const createShortLink: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    url: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    iosUrl: z.ZodOptional<z.ZodString>;
    androidUrl: z.ZodOptional<z.ZodString>;
    code: z.ZodOptional<z.ZodString>;
    expiresAt: z.ZodOptional<z.ZodString>;
    maxClicks: z.ZodOptional<z.ZodNumber>;
    expiredBehavior: z.ZodOptional<z.ZodEnum<["page", "redirect"]>>;
    expiredUrl: z.ZodOptional<z.ZodString>;
    expiredMessage: z.ZodOptional<z.ZodString>;
  }>
> = {
  name: "create_short_link",
  description: [
    "Create a short link for an app. Only `url` is required — everything else is optional. Returns the created link including `code` and the ready-to-share `shortUrl`. It redirects immediately; there is no publish step.",
    "",
    SHORT_LINK_PRIMER,
    "",
    "About `code`: OMIT IT unless the user asked for a specific vanity code. Omitted = a 6-character code is generated from an unambiguous alphabet (no 0/o, no 1/l/i) so it survives being read aloud or typed off a poster. A custom code is 3–40 chars of [a-z0-9-_], lowercased, and a handful of route-shadowing words are reserved; a code already in use returns 409. THE CODE CAN NEVER BE CHANGED afterwards — update_short_link will not touch it, so to rename you must create a new link and delete the old one (which breaks anything already shared).",
    "",
    "Note: new links are always created enabled. To ship one turned off, create it then call update_short_link with status:'disabled'.",
  ].join("\n"),
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    url: z
      .string()
      .min(1)
      .describe(
        "REQUIRED fallback destination — full URL with a scheme (https://… or a deep link like myapp://home). javascript:/data:/file: are rejected.",
      ),
    name: z
      .string()
      .max(120)
      .optional()
      .describe("Internal label shown in the dashboard. Defaults to 'Untitled link'."),
    iosUrl: z
      .string()
      .optional()
      .describe("Optional iOS-only destination. Omit and iOS visitors get `url`."),
    androidUrl: z
      .string()
      .optional()
      .describe("Optional Android-only destination. Omit and Android visitors get `url`."),
    code: z
      .string()
      .min(3)
      .max(40)
      .optional()
      .describe(
        "Optional vanity code. Omit to auto-generate. Immutable once created — choose deliberately.",
      ),
    expiresAt: z
      .string()
      .optional()
      .describe("Optional ISO 8601 timestamp after which the link stops redirecting."),
    maxClicks: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Optional click budget (≥1). The link stops redirecting once this many REAL clicks land; bot previews don't count.",
      ),
    expiredBehavior: z
      .enum(["page", "redirect"])
      .optional()
      .describe(
        "What an expired/exhausted link shows. 'page' (default) = branded 'link ended' page; 'redirect' = send to expiredUrl (which then becomes required).",
      ),
    expiredUrl: z
      .string()
      .optional()
      .describe("Destination once ended. Required when expiredBehavior is 'redirect'."),
    expiredMessage: z
      .string()
      .max(300)
      .optional()
      .describe("Custom copy on the 'link ended' page (expiredBehavior 'page' only)."),
  }),
  handler: (input, cfg) => {
    const { appIdOrSlug, ...body } = input;
    return apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(appIdOrSlug)}/links`,
      body,
    );
  },
};

// PATCH semantics: only keys actually present in the request body are touched,
// so we must forward exactly what the caller passed and nothing else. `null`
// is meaningful (it clears a field) and must survive; `undefined` must not be
// sent at all.
const UPDATABLE_LINK_FIELDS = [
  "name",
  "url",
  "iosUrl",
  "androidUrl",
  "status",
  "expiresAt",
  "maxClicks",
  "expiredBehavior",
  "expiredUrl",
  "expiredMessage",
  "resetClicks",
] as const;

export const updateShortLink: ToolDef<
  z.ZodObject<{
    appIdOrSlug: z.ZodString;
    linkIdOrCode: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    url: z.ZodOptional<z.ZodString>;
    iosUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    androidUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    status: z.ZodOptional<z.ZodEnum<["active", "disabled"]>>;
    expiresAt: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    maxClicks: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    expiredBehavior: z.ZodOptional<z.ZodEnum<["page", "redirect"]>>;
    expiredUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    expiredMessage: z.ZodOptional<z.ZodString>;
    resetClicks: z.ZodOptional<z.ZodBoolean>;
  }>
> = {
  name: "update_short_link",
  description: [
    "Partially update a short link. ONLY the fields you pass are changed — everything else is left alone, so a one-field edit is safe. The link keeps working at the same shortUrl throughout.",
    "",
    SHORT_LINK_PRIMER,
    "",
    "Clearing vs. leaving alone: pass null to CLEAR `iosUrl`, `androidUrl`, `expiresAt`, `maxClicks` or `expiredUrl` (clearing expiresAt/maxClicks removes that expiry rule and revives an ended link). Omit the field entirely to leave it untouched. `url` is the one field that can never be cleared — it's the fallback every other destination falls back to; send a replacement instead.",
    "",
    "`code` is NOT updatable and is rejected here: a short code is permanent once created, because it's already out in the world. To change it, create a new link and delete the old one.",
    "",
    "Reopening an exhausted link: pass resetClicks:true to zero the counter without deleting the recorded click history (the analytics from get_short_link are preserved). Pair it with a new maxClicks to extend the budget, or use status:'disabled' / 'active' to pause and resume a link without touching its limits at all.",
  ].join("\n"),
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    linkIdOrCode: z.string().min(1),
    name: z.string().max(120).optional(),
    url: z
      .string()
      .min(1)
      .optional()
      .describe("New fallback destination. Cannot be cleared — only replaced."),
    iosUrl: z
      .string()
      .nullable()
      .optional()
      .describe("New iOS destination, or null to clear it (iOS then uses `url`)."),
    androidUrl: z
      .string()
      .nullable()
      .optional()
      .describe("New Android destination, or null to clear it (Android then uses `url`)."),
    status: z
      .enum(["active", "disabled"])
      .optional()
      .describe("'disabled' stops the link redirecting immediately; 'active' resumes it."),
    expiresAt: z
      .string()
      .nullable()
      .optional()
      .describe("New ISO 8601 expiry, or null to remove the date limit."),
    maxClicks: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe("New click budget (≥1), or null to remove the click limit."),
    expiredBehavior: z.enum(["page", "redirect"]).optional(),
    expiredUrl: z
      .string()
      .nullable()
      .optional()
      .describe("Where an ended link redirects, or null to clear it."),
    expiredMessage: z
      .string()
      .max(300)
      .optional()
      .describe("Copy on the 'link ended' page. Pass an empty string to clear it."),
    resetClicks: z
      .boolean()
      .optional()
      .describe(
        "true zeroes clickCount (reopening a limit_reached link) while keeping the click history for analytics.",
      ),
  }),
  handler: (input, cfg) => {
    const body: Record<string, unknown> = {};
    for (const key of UPDATABLE_LINK_FIELDS) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) body[key] = value;
    }
    return apiFetch(
      cfg,
      "PATCH",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/links/${encodeURIComponent(input.linkIdOrCode)}`,
      body,
    );
  },
};

export const deleteShortLink: ToolDef<typeof shortLinkRef> = {
  name: "delete_short_link",
  description:
    "Permanently delete a short link and its recorded clicks. IRREVERSIBLE, and the code dies with it — anyone who already has the shortUrl (a printed QR, a scheduled post, an old tweet) gets a dead link, and the code may later be claimed by someone else. Prefer update_short_link with status:'disabled' to switch a link off while keeping the code reserved and the analytics readable. Returns { deleted, id, code }.",
  inputSchema: shortLinkRef,
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "DELETE",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/links/${encodeURIComponent(input.linkIdOrCode)}`,
    ),
};

export const ALL_TOOLS = [
  createApp,
  getQrCode,
  listFlows,
  createShortLink,
  createWishlistIdea,
  deleteShortLink,
  deleteWishlistComment,
  deleteWishlistIdea,
  exportOnboardingCsv,
  exportReferralsCsv,
  exportWaitlistCsv,
  exportWishlistCsv,
  getApp,
  getAppPromotionFlow,
  getAppStorePrivacyDeclaration,
  getCancelFlow,
  getContactFlow,
  getCrashFlow,
  getFeedbackFlow,
  getLegalFlow,
  getLinkPageFlow,
  getOnboardingFlow,
  getReferralFlow,
  getReportFlow,
  getShortLink,
  getWaitlistFlow,
  getWishlistFlow,
  listApps,
  listContactSubmissions,
  listCrashSubmissions,
  listFeedbackSubmissions,
  listOnboardingSubmissions,
  listReferrals,
  listReportSubmissions,
  listShortLinks,
  listWaitlistSignups,
  listWishlistComments,
  listWishlistIdeas,
  postWishlistComment,
  publishCancelFlow,
  publishContactFlow,
  publishCrashFlow,
  publishFeedbackFlow,
  publishLinkPageFlow,
  publishOnboardingFlow,
  publishReferralFlow,
  publishReportFlow,
  publishAppPromotionFlow,
  publishLegalFlow,
  publishWaitlistFlow,
  publishWishlistFlow,
  replyToContactSubmission,
  setCrashReportStatus,
  setWishlistIdeaStatus,
  updateAppPromotionDraft,
  updateCancelDraft,
  updateContactDraft,
  updateCrashDraft,
  updateLegalDraft,
  updateFeedbackDraft,
  updateLinkPageDraft,
  updateOnboardingDraft,
  updateReferralDraft,
  updateReportDraft,
  updateShortLink,
  updateWaitlistDraft,
  updateWishlistDraft,
] as const;

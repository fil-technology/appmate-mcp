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

export const getPreCancelFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "get_pre_cancel_flow",
  description:
    "Read the published and draft pre-cancel flow configs for an app.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "GET",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/pre-cancel`,
    ),
};

// We keep the config body as `z.unknown()` so the LLM can hand us any
// pre-cancel JSON without hitting our (deliberately permissive) wrapper
// schema first. The server validates strictly and returns the failing
// paths if invalid.
export const updatePreCancelDraft: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString; config: z.ZodUnknown }>
> = {
  name: "update_pre_cancel_draft",
  description:
    "Replace the draft pre-cancel flow config. Body MUST be a full pre-cancel config object (type: 'pre_cancel'). The server validates strictly and returns 422 with the failing paths on mismatch.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    config: z.unknown(),
  }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "PUT",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/pre-cancel`,
      input.config,
    ),
};

export const publishPreCancelFlow: ToolDef<
  z.ZodObject<{ appIdOrSlug: z.ZodString }>
> = {
  name: "publish_pre_cancel_flow",
  description:
    "Promote the draft pre-cancel config to the live published version. The live cancel URL flips on success.",
  inputSchema: z.object({ appIdOrSlug: z.string().min(1) }),
  handler: (input, cfg) =>
    apiFetch(
      cfg,
      "POST",
      `/api/v1/apps/${encodeURIComponent(input.appIdOrSlug)}/flows/pre-cancel/publish`,
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
  z.ZodObject<{ appIdOrSlug: z.ZodString; config: z.ZodUnknown }>
> = {
  name: "update_waitlist_draft",
  description:
    "Replace the draft waitlist config. Body MUST be a full waitlist config object (type: 'waitlist'). Server validates strictly.",
  inputSchema: z.object({
    appIdOrSlug: z.string().min(1),
    config: z.unknown(),
  }),
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

// Registered alphabetically so `list_tools` reads predictably.
export const ALL_TOOLS = [
  createApp,
  exportWaitlistCsv,
  getApp,
  getPreCancelFlow,
  getWaitlistFlow,
  listApps,
  listWaitlistSignups,
  publishPreCancelFlow,
  publishWaitlistFlow,
  updatePreCancelDraft,
  updateWaitlistDraft,
] as const;

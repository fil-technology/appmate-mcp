# appmate-mcp

Model Context Protocol server for [AppMate](https://appmate.cloud) — lets
Claude Desktop, Claude Code, Cursor, Codex, or any other MCP-aware client
drive AppMate via typed tools. List apps, edit cancel flows, publish,
export waitlists — without leaving the chat.

```bash
npx -y @fil-technology/appmate-mcp
```

## Setup (1 minute)

1. Issue a token at <https://flow.appmate.cloud/admin/api-tokens>. Copy the
   `amk_…` string — it's only shown once.
2. Add the server to your MCP host's config (examples below).
3. Restart the host and ask your agent: *"list my appmate apps"*.

### Claude Desktop / Claude Code

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (on
macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "appmate": {
      "command": "npx",
      "args": ["-y", "@fil-technology/appmate-mcp"],
      "env": {
        "APPMATE_TOKEN": "amk_…",
        "APPMATE_API_URL": "https://flow.appmate.cloud"
      }
    }
  }
}
```

### Cursor / Codex (`.mcp.json` in your project)

```json
{
  "mcpServers": {
    "appmate": {
      "command": "npx",
      "args": ["-y", "@fil-technology/appmate-mcp"],
      "env": { "APPMATE_TOKEN": "amk_…" }
    }
  }
}
```

`APPMATE_API_URL` defaults to `https://flow.appmate.cloud`. Override for
staging or self-hosted instances.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_apps` | List every app the token can see. |
| `get_app` | Fetch one app by id or slug. |
| `create_app` | Create a new app. |
| `get_qr_code` | Shareable QR-code image URLs (PNG + SVG) for any flow's public page, logo centred. |
| `list_flows` | List an app's flows. cancel + waitlist can have **multiple** per app; others are one each. |
| `get_cancel_flow` | Read published + draft cancel config (`flowSlug` → a secondary flow). |
| `update_cancel_draft` | Replace the draft with new config JSON. |
| `publish_cancel_flow` | Promote the draft live. |
| `get_waitlist_flow` | Read published + draft waitlist config (`flowSlug` → a secondary waitlist). |
| `update_waitlist_draft` | Replace the waitlist draft. |
| `publish_waitlist_flow` | Promote the waitlist draft live. |
| `list_waitlist_signups` | Paginated list (cursor + nextCursor). |
| `export_waitlist_csv` | Return the full waitlist as a CSV string. |
| `get_feedback_flow` | Read published + draft feedback config. |
| `update_feedback_draft` | Replace the feedback draft. |
| `publish_feedback_flow` | Promote the feedback draft live. |
| `list_feedback_submissions` | Paginated list of feedback rows (rating + message + email). |
| `get_report_flow` | Read published + draft report config. |
| `update_report_draft` | Replace the report draft (categorised). |
| `publish_report_flow` | Promote the report draft live. |
| `list_report_submissions` | Paginated, optional `category` filter. |
| `get_crash_flow` | Read published + draft crash flow config. |
| `update_crash_draft` | Replace the crash draft (message + optional log/email fields). |
| `publish_crash_flow` | Promote the crash draft live. |
| `list_crash_submissions` | Paginated crash reports incl. diagnostics; optional `status` filter. |
| `set_crash_report_status` | Triage a crash report: new → reviewed → resolved. |
| `get_contact_flow` | Read published + draft contact config. |
| `update_contact_draft` | Replace the contact draft. |
| `publish_contact_flow` | Promote the contact draft live. |
| `list_contact_submissions` | Paginated list of contact rows (name + email + message). |
| `get_onboarding_flow` | Read published + draft onboarding (web-to-app funnel) config. |
| `update_onboarding_draft` | Replace the onboarding draft (quiz / info / email-capture steps + handoff). |
| `publish_onboarding_flow` | Promote the onboarding draft live. |
| `list_onboarding_submissions` | Paginated list of funnel completions (answers + email + claim status). |
| `export_onboarding_csv` | Return all onboarding completions as a CSV string. |
| `get_referral_flow` | Read published + draft referral program config. |
| `update_referral_draft` | Replace the referral draft (rewards, share text, cap, landing). |
| `publish_referral_flow` | Promote the referral draft live. |
| `list_referrals` | Paginated referral graph (status, `source` [link or typed-code], referee, reward flags). |
| `export_referrals_csv` | Return the full referral graph as a CSV string. |
| `get_link_page_flow` | Read published + draft link-page (link-in-bio) config. |
| `update_link_page_draft` | Replace the link-page draft (header, icon links, link list, theme). |
| `publish_link_page_flow` | Promote the link-page draft live (appmate.cloud/p/{appSlug}). |

Each referrer gets a unique link **and** a short, human-readable code (e.g.
`K7Q4-R9XP`); a friend redeems by tapping the link or **typing the code** (no
clipboard needed). `source` on each referral row records which path was used.

Tools that accept an app reference (`get_app`, `update_cancel_draft`,
etc.) accept either the cuid `id` or the human-readable `slug` — use
whichever you have. The full REST shape is documented at
<https://docs.appmate.cloud/api-reference>.

## Example agent prompts

> *"Create an AppMate app called `Ledgr` with bundle id
> `com.acme.ledgr`, then publish a simple cancel flow that offers a 20%
> discount for the `too_expensive` reason."*

> *"Export the waitlist for `appmate-pro` as CSV and save it to
> `~/Downloads/waitlist.csv`."*

> *"Build a 3-question onboarding funnel for `ledgr` that asks the user's
> goal, captures their email, and hands off to the App Store, then publish
> it."*

> *"Compare the published and draft cancel configs for `quakemate` and
> tell me what changed."*

## Local development

```bash
pnpm install
pnpm dev    # tsx src/index.ts — talks MCP over stdio
pnpm build  # emits dist/index.js
```

## Security

- Tokens are bcrypt-hashed server-side and only shown once on creation.
- Revoke from the dashboard the moment a token leaks.
- All calls go over TLS to `flow.appmate.cloud`. No data sits on disk in
  the MCP process beyond what your MCP host logs.

## License

MIT. See `LICENSE`.

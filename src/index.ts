#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ALL_TOOLS } from "./tools.js";
import { AppMateApiError, type ApiConfig } from "./api-client.js";

// stdio MCP entry. Install: `npx -y @fil-technology/appmate-mcp`.
//
// Auth: APPMATE_TOKEN env var (or --token CLI flag). Base URL defaults to
// https://flow.appmate.cloud — override with APPMATE_API_URL for staging
// or self-hosted setups.

function parseCli(): { token: string | null; apiUrl: string } {
  let token = process.env.APPMATE_TOKEN ?? null;
  let apiUrl =
    process.env.APPMATE_API_URL ?? "https://flow.appmate.cloud";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--token" && argv[i + 1]) {
      token = argv[i + 1] ?? null;
      i++;
    } else if (a?.startsWith("--token=")) {
      token = a.slice("--token=".length);
    } else if (a === "--api-url" && argv[i + 1]) {
      apiUrl = argv[i + 1] ?? apiUrl;
      i++;
    } else if (a?.startsWith("--api-url=")) {
      apiUrl = a.slice("--api-url=".length);
    }
  }
  return { token, apiUrl };
}

async function main() {
  const { token, apiUrl } = parseCli();
  if (!token) {
    // Emit on stderr — stdout is reserved for the MCP wire protocol.
    process.stderr.write(
      [
        "appmate-mcp: missing token. Set APPMATE_TOKEN or pass --token amk_...",
        "",
        "Issue a token at https://flow.appmate.cloud/admin/api-tokens.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }

  const cfg: ApiConfig = { baseUrl: apiUrl, token };

  const server = new Server(
    { name: "appmate-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.inputSchema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    // Type-erase at the registration boundary: each tool has its own
    // inputSchema/handler input type, but the union of handlers expects
    // the *intersection* of input types, not the union. Cast to a loose
    // shape — the per-tool zod schema is what actually validates input.
    const tool = (ALL_TOOLS as readonly {
      name: string;
      description: string;
      inputSchema: z.ZodTypeAny;
      handler: (input: unknown, cfg: ApiConfig) => Promise<unknown>;
    }[]).find((t) => t.name === req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Unknown tool: ${req.params.name}`,
          },
        ],
      };
    }
    try {
      const parsed = tool.inputSchema.parse(req.params.arguments ?? {});
      const result = await tool.handler(parsed, cfg);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    } catch (err) {
      const msg =
        err instanceof AppMateApiError
          ? `AppMate API ${err.status}: ${JSON.stringify(err.body, null, 2)}`
          : err instanceof Error
            ? err.message
            : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: msg }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Lightweight Zod-to-JSON-Schema. The MCP SDK accepts JSON-Schema-shaped
// input schemas — we shape only what our tools actually use (object with
// string/number/optional fields), which keeps the dependency footprint
// tiny vs. pulling in `zod-to-json-schema`.

type JsonSchema = Record<string, unknown>;

function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [k, v] of Object.entries(shape)) {
      const inner = unwrapOptional(v);
      properties[k] = zodToJsonSchema(inner.schema);
      if (!inner.optional) required.push(k);
    }
    const out: JsonSchema = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    return out;
  }
  if (schema instanceof z.ZodString) {
    return { type: "string" };
  }
  if (schema instanceof z.ZodNumber) {
    return { type: "number" };
  }
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean" };
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) {
    return {};
  }
  return {};
}

function unwrapOptional(
  schema: z.ZodTypeAny,
): { schema: z.ZodTypeAny; optional: boolean } {
  if (schema instanceof z.ZodOptional) {
    return { schema: schema._def.innerType, optional: true };
  }
  return { schema, optional: false };
}

main().catch((err) => {
  process.stderr.write(
    `appmate-mcp: fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});

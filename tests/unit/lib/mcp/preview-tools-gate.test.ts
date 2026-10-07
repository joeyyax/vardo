import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpAuthContext } from "@/lib/mcp/auth";

// Every preview tool answers "not enabled" while previews are off, before
// touching the database, the rate limiter or Docker.

const { untouched } = vi.hoisted(() => ({
  untouched: () =>
    new Proxy({}, {
      get: (_t, key) => {
        throw new Error(`touched ${String(key)}`);
      },
    }),
}));

vi.mock("@/lib/config/features", () => ({ isFeatureEnabledAsync: vi.fn().mockResolvedValue(false) }));
vi.mock("@/lib/db", () => ({ db: untouched() }));
vi.mock("@/lib/api/rate-limit", () => ({ slidingWindowRateLimit: vi.fn(() => Promise.reject(new Error("rate limiter reached"))) }));
vi.mock("@/lib/docker/preview", () => ({ createPreview: vi.fn(() => Promise.reject(new Error("createPreview reached"))) }));
vi.mock("@/lib/docker/clone", () => ({ destroyGroupEnvironment: vi.fn(() => Promise.reject(new Error("destroy reached"))) }));
vi.mock("@/lib/mcp/scope", () => ({
  canAccessOrg: vi.fn(() => Promise.reject(new Error("scope reached"))),
  accessibleOrgIds: vi.fn(() => Promise.reject(new Error("scope reached"))),
  orgFilter: vi.fn(),
  orgLabels: vi.fn(),
}));

import { registerCreatePreview } from "@/lib/mcp/tools/create-preview";
import { registerListPreviews } from "@/lib/mcp/tools/list-previews";
import { registerGetPreviewStatus } from "@/lib/mcp/tools/get-preview-status";
import { registerGetPreviewUrl } from "@/lib/mcp/tools/get-preview-url";
import { registerDestroyPreview } from "@/lib/mcp/tools/destroy-preview";

type Handler = (args: Record<string, unknown>) => Promise<{ isError?: boolean; content: { text: string }[] }>;

const handlers = new Map<string, Handler>();
const server = {
  tool: (name: string, ...rest: unknown[]) => handlers.set(name, rest.at(-1) as Handler),
} as unknown as McpServer;
const context = { userId: "u", organizationId: "org-1" } as McpAuthContext;

for (const register of [
  registerCreatePreview,
  registerListPreviews,
  registerGetPreviewStatus,
  registerGetPreviewUrl,
  registerDestroyPreview,
]) {
  register(server, context);
}

const ARGS: Record<string, Record<string, unknown>> = {
  vardo_create_preview: { repo: "a/b", branch: "x", pr_number: 1, ttl_days: 7 },
  vardo_list_previews: { limit: 50, offset: 0 },
  vardo_get_preview_status: { preview_id: "ge-1" },
  vardo_get_preview_url: { preview_id: "ge-1" },
  vardo_destroy_preview: { preview_id: "ge-1" },
};

describe("MCP preview tools with previews off", () => {
  it("registers all five", () => {
    expect([...handlers.keys()].sort()).toEqual(Object.keys(ARGS).sort());
  });

  it.each(Object.keys(ARGS))("%s refuses", async (name) => {
    const result = await handlers.get(name)!(ARGS[name]);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({ error: "Previews are not enabled on this instance" });
  });
});

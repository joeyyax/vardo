// Receiving side of a forwarded MCP call: signed peer auth, opt-in, user mapping, scope and audit.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { hashMeshToken } from "@/lib/mesh/auth";
import { signMeshRequest } from "@/lib/mesh/signing";

const TOKEN = "c".repeat(64);

const state = vi.hoisted(() => ({
  peer: {} as Record<string, unknown>,
  user: { id: "remote-u1" } as { id: string } | null,
  membership: { organizationId: "remote-org-2" } as { organizationId: string } | null,
  seen: new Set<string>(),
}));
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));
const seenContexts = vi.hoisted(() => [] as unknown[]);

vi.mock("@/lib/mesh/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/auth")>()),
  requireMeshPeer: async () => state.peer,
}));
vi.mock("@/lib/redis", () => ({
  redis: {
    set: async (key: string) => {
      if (state.seen.has(key)) return null;
      state.seen.add(key);
      return "OK";
    },
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: async () => state.user },
      memberships: { findFirst: async () => state.membership },
    },
  },
}));
vi.mock("@/lib/system-settings", () => ({ getInstanceDisplayName: async () => "prod" }));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/api/require-plugin", () => ({ requirePlugin: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/api/with-rate-limit", async () => (await import("@/tests/helpers/mocks")).withRateLimitModule());
vi.mock("@/lib/mcp/registry", () => ({
  collectTools: (context: { adminScope?: boolean }) => {
    const echo = async (args: unknown) => {
      seenContexts.push(context);
      return { content: [{ type: "text", text: JSON.stringify({ args }) }] };
    };
    const tools = new Map<string, unknown>([
      ["vardo_list_apps", { name: "vardo_list_apps", shape: { limit: z.number().default(50) }, handler: echo }],
    ]);
    if (context.adminScope) tools.set("vardo_get_email_settings", { name: "vardo_get_email_settings", shape: {}, handler: echo });
    return tools;
  },
}));

const { POST } = await import("@/app/api/v1/mesh/mcp-call/route");

function call(over: Record<string, unknown> = {}) {
  return {
    tool: "vardo_list_apps",
    arguments: {},
    user: { email: "Owner@example.com" },
    scope: { capabilities: null, crossOrg: false, admin: false },
    ...over,
  };
}

function request(payload: unknown, { token = TOKEN, headers }: { token?: string; headers?: Record<string, string> } = {}) {
  const body = JSON.stringify(payload);
  return new NextRequest("http://192.0.2.10:3000/api/v1/mesh/mcp-call", {
    method: "POST",
    body,
    headers: headers ?? { ...signMeshRequest({ token, method: "POST", path: "/api/v1/mesh/mcp-call", body }) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seenContexts.length = 0;
  state.seen.clear();
  state.user = { id: "remote-u1" };
  state.membership = { organizationId: "remote-org-2" };
  state.peer = {
    id: "peer-canary",
    instanceId: "canary-id",
    name: "canary",
    tokenHash: hashMeshToken(TOKEN),
    acceptMcp: true,
    organizationId: "remote-org-1",
  };
});

describe("POST /api/v1/mesh/mcp-call", () => {
  it("runs the tool as the mapped user in the peer's bound org and records it via the origin", async () => {
    const res = await POST(request(call({ arguments: { limit: 5 } })));
    expect(res.status).toBe(200);
    const { result } = await res.json();
    expect(JSON.parse(result.content[0].text)).toEqual({ args: { limit: 5 } });
    expect(seenContexts[0]).toMatchObject({
      userId: "remote-u1",
      organizationId: "remote-org-1",
      crossOrg: false,
      linkedInstances: false,
      via: { peerId: "peer-canary", name: "canary" },
    });
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "remote-org-1",
        action: "mesh.mcp_received",
        userId: "remote-u1",
        metadata: expect.objectContaining({ tool: "vardo_list_apps", trigger: "canary" }),
      })
    );
  });

  it("rejects a bad signature, a tampered body and a replay", async () => {
    expect((await POST(request(call(), { token: "d".repeat(64) }))).status).toBe(401);

    const body = JSON.stringify(call());
    const headers = signMeshRequest({ token: TOKEN, method: "POST", path: "/api/v1/mesh/mcp-call", body });
    const tampered = new NextRequest("http://192.0.2.10:3000/api/v1/mesh/mcp-call", {
      method: "POST",
      body: JSON.stringify(call({ tool: "vardo_delete_app" })),
      headers,
    });
    expect((await POST(tampered)).status).toBe(401);

    const first = new NextRequest("http://192.0.2.10:3000/api/v1/mesh/mcp-call", { method: "POST", body, headers });
    const again = new NextRequest("http://192.0.2.10:3000/api/v1/mesh/mcp-call", { method: "POST", body, headers });
    expect((await POST(first)).status).toBe(200);
    expect((await POST(again)).status).toBe(401);
    expect(seenContexts).toHaveLength(1);
  });

  it("refuses a peer this instance hasn't opted in", async () => {
    state.peer.acceptMcp = false;
    const res = await POST(request(call()));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/doesn't accept MCP calls from canary/);
    expect(seenContexts).toHaveLength(0);
  });

  it("refuses when no verified user has the email", async () => {
    state.user = null;
    const res = await POST(request(call()));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("No user with that verified email on prod");
  });

  it("needs a bound org unless the token spans organizations", async () => {
    state.peer.organizationId = null;
    expect((await POST(request(call()))).status).toBe(403);

    const res = await POST(request(call({ scope: { capabilities: null, crossOrg: true, admin: false } })));
    expect(res.status).toBe(200);
    expect(seenContexts[0]).toMatchObject({ organizationId: "remote-org-2", crossOrg: true });
  });

  it("keeps the token's capabilities and drops unknown ones", async () => {
    await POST(request(call({ scope: { capabilities: ["app.view", "root.everything"], crossOrg: false, admin: false } })));
    expect([...(seenContexts[0] as { scopes: Set<string> }).scopes]).toEqual(["app.view"]);
  });

  it("doesn't expose admin tools to a call without the admin scope", async () => {
    const res = await POST(request(call({ tool: "vardo_get_email_settings" })));
    expect(res.status).toBe(404);
    const admin = await POST(
      request(call({ tool: "vardo_get_email_settings", scope: { capabilities: null, crossOrg: false, admin: true } }))
    );
    expect(admin.status).toBe(200);
    expect(seenContexts[0]).toMatchObject({ adminScope: true });
  });

  it("validates arguments against the tool's own schema", async () => {
    expect((await POST(request(call({ arguments: { limit: "lots" } })))).status).toBe(400);
  });

  it("rejects extra fields in the call", async () => {
    expect((await POST(request({ ...call(), linkedInstances: true }))).status).toBe(400);
  });
});

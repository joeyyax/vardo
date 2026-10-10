// The MCP dispatcher: local calls run in place, peer calls go out signed only for an allowed token, and both are labeled.

import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  user: { email: "owner@example.com", emailVerified: true, isAppAdmin: true } as Record<string, unknown> | null,
  peers: [] as Record<string, unknown>[],
}));
const meshSignedPost = vi.hoisted(() => vi.fn());
const recordActivity = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      user: { findFirst: async () => state.user },
      meshPeers: { findMany: async () => state.peers },
    },
  },
}));
vi.mock("@/lib/constants", () => ({ getInstanceId: async () => "local-id" }));
vi.mock("@/lib/system-settings", () => ({
  getInstanceConfig: async () => ({ instanceName: "canary", domain: "canary.example.com", baseDomain: "", serverIp: "" }),
}));
vi.mock("@/lib/self-update/store", () => ({ getUpdatePolicy: async () => ({ canary: { role: "none" } }) }));
vi.mock("@/lib/activity", () => ({ recordActivity }));
vi.mock("@/lib/mesh/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/mesh/client")>()),
  meshSignedPost,
}));

import { dispatchTool } from "@/lib/mcp/dispatch";
import type { McpAuthContext } from "@/lib/mcp/auth";
import type { ToolDef } from "@/lib/mcp/registry";

const prod = { id: "peer-1", instanceId: "prod-id", name: "prod", connectionType: "direct" };
const extra = { signal: new AbortController().signal };
const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ apps: [] }) }] }));
const def: ToolDef = { name: "vardo_list_apps", description: "", shape: {}, handler };

function ctx(over: Partial<McpAuthContext> = {}): McpAuthContext {
  return { userId: "u1", organizationId: "org-1", crossOrg: false, scopes: null, adminScope: false, linkedInstances: true, ...over };
}

function body(result: { content: unknown[] }) {
  return JSON.parse((result.content[0] as { text: string }).text);
}

beforeEach(() => {
  vi.clearAllMocks();
  state.user = { email: "owner@example.com", emailVerified: true, isAppAdmin: true };
  state.peers = [prod, { id: "peer-2", instanceId: "far-id", name: "far", connectionType: "visible" }];
  meshSignedPost.mockResolvedValue({
    data: { result: { content: [{ type: "text", text: JSON.stringify({ apps: ["remote"] }) }] } },
    transport: "tunnel",
  });
});

describe("routing", () => {
  it("runs locally without an instance and leaves the result as is", async () => {
    const result = await dispatchTool(ctx(), def, { limit: 5 }, extra);
    expect(handler).toHaveBeenCalledWith({ limit: 5 }, extra);
    expect(body(result)).toEqual({ apps: [] });
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("runs locally for the local name and labels the result", async () => {
    const result = await dispatchTool(ctx({ linkedInstances: false }), def, { instance: "Canary" }, extra);
    expect(handler).toHaveBeenCalledWith({}, extra);
    expect(body(result).instance).toEqual({ id: "local-id", name: "canary" });
  });

  it("forwards to a peer by name and labels the result with it", async () => {
    const result = await dispatchTool(ctx(), def, { instance: "prod", limit: 5 }, extra);
    expect(handler).not.toHaveBeenCalled();
    expect(meshSignedPost).toHaveBeenCalledWith(
      "peer-1",
      "/api/v1/mesh/mcp-call",
      expect.objectContaining({ tool: "vardo_list_apps", arguments: { limit: 5 }, user: { email: "owner@example.com" } })
    );
    expect(body(result)).toEqual({ instance: { id: "peer-1", name: "prod", via: "tunnel" }, apps: ["remote"] });
    expect(result._meta?.["vardo/instance"]).toMatchObject({ name: "prod" });
  });

  it("names unknown and hub-only instances", async () => {
    expect(body(await dispatchTool(ctx(), def, { instance: "nope" }, extra)).error).toMatch(/No linked instance/);
    expect(body(await dispatchTool(ctx(), def, { instance: "far" }, extra)).error).toMatch(/only visible through a hub/);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("refuses a name that matches both this instance and a peer", async () => {
    state.peers = [{ ...prod, name: "canary" }];
    expect(body(await dispatchTool(ctx(), def, { instance: "canary" }, extra)).error).toMatch(/more than one/);
  });
});

describe("scope enforcement", () => {
  it("refuses a token without linked-instance access", async () => {
    const result = await dispatchTool(ctx({ linkedInstances: false }), def, { instance: "prod" }, extra);
    expect(result.isError).toBe(true);
    expect(body(result).error).toMatch(/can't act on linked instances/);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("refuses once the user is no longer an instance admin", async () => {
    state.user = { email: "owner@example.com", emailVerified: true, isAppAdmin: false };
    expect(body(await dispatchTool(ctx(), def, { instance: "prod" }, extra)).error).toMatch(/needs an instance admin/);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("refuses an unverified email", async () => {
    state.user = { email: "owner@example.com", emailVerified: false, isAppAdmin: true };
    expect(body(await dispatchTool(ctx(), def, { instance: "prod" }, extra)).error).toMatch(/Verify your email/);
  });

  it("never forwards a call that arrived from a peer", async () => {
    const via = { peerId: "x", instanceId: "y", name: "z" };
    expect(body(await dispatchTool(ctx({ via }), def, { instance: "prod" }, extra)).error).toMatch(/forwarded again/);
    expect(meshSignedPost).not.toHaveBeenCalled();
  });

  it("carries the token's scope, not more", async () => {
    await dispatchTool(ctx({ scopes: new Set(["app.view"]), crossOrg: true }), def, { instance: "prod" }, extra);
    expect(meshSignedPost.mock.calls[0][2].scope).toEqual({ capabilities: ["app.view"], crossOrg: true, admin: false });
  });
});

describe("audit and failures", () => {
  it("records a forwarded call here", async () => {
    await dispatchTool(ctx(), def, { instance: "prod" }, extra);
    expect(recordActivity).toHaveBeenCalledWith({
      organizationId: "org-1",
      action: "mesh.mcp_forwarded",
      userId: "u1",
      metadata: { tool: "vardo_list_apps", instance: "prod", peerId: "peer-1", transport: "tunnel" },
    });
  });

  it("returns the peer's refusal as a tool error and records it", async () => {
    const { MeshClientError } = await import("@/lib/mesh/client");
    meshSignedPost.mockRejectedValueOnce(new MeshClientError("No user with that verified email on prod", "PEER_ERROR", 403));
    const result = await dispatchTool(ctx(), def, { instance: "prod" }, extra);
    expect(result.isError).toBe(true);
    expect(body(result).error).toBe("prod: No user with that verified email on prod");
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ error: "No user with that verified email on prod" }) })
    );
  });

  it("rejects a malformed result from the peer", async () => {
    meshSignedPost.mockResolvedValueOnce({ data: { result: { nope: true } }, transport: "public" });
    expect(body(await dispatchTool(ctx(), def, { instance: "prod" }, extra)).error).toMatch(/malformed/);
  });
});

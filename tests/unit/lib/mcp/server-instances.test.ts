// Every MCP tool takes an instance argument, and vardo_list_instances shows peers only to a linked-instance token.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { dbMock } = await import("@/tests/helpers/db");
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/constants", () => ({ getInstanceId: async () => "local-id" }));
vi.mock("@/lib/system-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/system-settings")>()),
  getInstanceConfig: async () => ({ instanceName: "canary", domain: "canary.example.com", baseDomain: "", serverIp: "" }),
}));
vi.mock("@/lib/self-update/store", () => ({
  getUpdatePolicy: async () => ({ mode: "auto", priority: "standard", channel: "releases" }),
}));

const { createMcpServer } = await import("@/lib/mcp/server");
const { peerHealthy } = await import("@/lib/mcp/instances");

async function connect(linkedInstances: boolean, adminScope = false) {
  const server = createMcpServer({ userId: "u1", organizationId: "o1", crossOrg: false, linkedInstances, adminScope });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientT);
  return client;
}

beforeEach(() => {
  dbMock.reset();
  dbMock.query.user.findFirst.mockResolvedValue({ isAppAdmin: true });
  dbMock.query.meshPeers.findMany.mockResolvedValue([
    {
      id: "peer-1",
      instanceId: "prod-id",
      name: "prod",
      type: "persistent",
      status: "online",
      connectionType: "direct",
      publicApiUrl: "https://prod.example.com",
      vardoSha: "abc1234",
      vardoHealthy: true,
      vardoUpdate: { protocol: 1, mode: "auto", priority: "critical", channel: "releases" },
      lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    },
    { id: "peer-2", instanceId: "far-id", name: "far", connectionType: "visible" },
  ]);
});

describe("MCP server across instances", () => {
  it("adds an optional instance argument to every tool but the instance list", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
      if (tool.name === "vardo_list_instances") expect(props.instance).toBeUndefined();
      else expect(props.instance, tool.name).toBeDefined();
      expect(tool.inputSchema.required ?? []).not.toContain("instance");
    }
    await client.close();
  });

  it("adds the instance argument to the admin-only status tools", async () => {
    const client = await connect(false, true);
    const { tools } = await client.listTools();
    for (const name of ["vardo_instance_status", "vardo_list_tasks", "vardo_update_now", "vardo_get_update_policy", "vardo_set_update_policy"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect((tool!.inputSchema.properties ?? {}).instance, name).toBeDefined();
    }
    await client.close();
  });

  it("hides the admin-only status tools from a token without the admin scope", async () => {
    const client = await connect(false);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["vardo_instance_status", "vardo_list_tasks", "vardo_update_now", "vardo_get_update_policy", "vardo_set_update_policy"]) expect(names).not.toContain(name);
    for (const name of ["vardo_list_attention", "vardo_list_backup_jobs", "vardo_list_backups", "vardo_list_deployments", "vardo_list_activity", "vardo_security_summary", "vardo_run_backup"]) {
      expect(names).toContain(name);
    }
    await client.close();
  });

  it("lists linked peers for a linked-instance token", async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: "vardo_list_instances", arguments: {} });
    const { instances } = JSON.parse((result.content as { text: string }[])[0].text);
    expect(instances.map((i: { name: string }) => i.name)).toEqual(["canary", "prod"]);
    expect(instances[0]).toMatchObject({ local: true, priority: "standard", url: "https://canary.example.com" });
    expect(instances[1]).toMatchObject({ id: "peer-1", priority: "critical", version: "abc1234", status: "online", healthy: false });
    await client.close();
  });

  it("lists only this instance otherwise", async () => {
    const client = await connect(false);
    const result = await client.callTool({ name: "vardo_list_instances", arguments: {} });
    const { instances, note } = JSON.parse((result.content as { text: string }[])[0].text);
    expect(instances).toHaveLength(1);
    expect(note).toMatch(/can't act on linked instances/);
    await client.close();
  });
});

describe("peerHealthy", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const seen = (ms: number) => new Date(now.getTime() - ms);

  it("is true for an online peer seen recently that sent no health report", () => {
    expect(peerHealthy({ status: "online", lastSeenAt: seen(30_000), vardoHealthy: null }, now)).toBe(true);
    expect(peerHealthy({ status: "online", lastSeenAt: seen(30_000), vardoHealthy: true }, now)).toBe(true);
  });

  it("is false for a peer that's offline, silent, never seen or reporting itself unhealthy", () => {
    expect(peerHealthy({ status: "offline", lastSeenAt: seen(30_000), vardoHealthy: true }, now)).toBe(false);
    expect(peerHealthy({ status: "online", lastSeenAt: seen(6 * 60_000), vardoHealthy: true }, now)).toBe(false);
    expect(peerHealthy({ status: "online", lastSeenAt: null, vardoHealthy: true }, now)).toBe(false);
    expect(peerHealthy({ status: "online", lastSeenAt: seen(30_000), vardoHealthy: false }, now)).toBe(false);
  });
});

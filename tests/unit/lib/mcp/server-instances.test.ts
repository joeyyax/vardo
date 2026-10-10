// Every MCP tool takes an instance argument, and vardo_list_instances shows peers only to a linked-instance token.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { dbMock } = await import("@/tests/helpers/db");
vi.mock("@/lib/db", async () => (await import("@/tests/helpers/db")).dbModule());
vi.mock("@/lib/constants", () => ({ getInstanceId: async () => "local-id" }));
vi.mock("@/lib/system-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/system-settings")>()),
  getInstanceConfig: async () => ({ instanceName: "canary", domain: "canary.example.com", baseDomain: "", serverIp: "" }),
}));
vi.mock("@/lib/self-update/store", () => ({
  getUpdatePolicy: async () => ({ canary: { role: "follower", canaryInstanceId: "prod-id", soakHours: 24 } }),
}));

const { createMcpServer } = await import("@/lib/mcp/server");

async function connect(linkedInstances: boolean) {
  const server = createMcpServer({ userId: "u1", organizationId: "o1", crossOrg: false, linkedInstances });
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

  it("lists linked peers for a linked-instance token", async () => {
    const client = await connect(true);
    const result = await client.callTool({ name: "vardo_list_instances", arguments: {} });
    const { instances } = JSON.parse((result.content as { text: string }[])[0].text);
    expect(instances.map((i: { name: string }) => i.name)).toEqual(["canary", "prod"]);
    expect(instances[0]).toMatchObject({ local: true, role: "follower", url: "https://canary.example.com" });
    expect(instances[1]).toMatchObject({ id: "peer-1", role: "canary", version: "abc1234", status: "online" });
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

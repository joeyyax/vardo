// Channel project filters against a scratch Postgres, through both delivery paths.
// Skips without a Postgres it can create databases on: MIGRATE_TEST_ADMIN_URL, DATABASE_URL or a DATABASE_URL line in .env.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { MIGRATE_TIMEOUT, connectScratchServer, runMigrate, scratchName } from "../unit/drizzle/scratch-db";
import type { BusEvent } from "@/lib/bus/events";

type Handler = (key: string, entry: { id: string; fields: Record<string, string> }) => Promise<void>;

const h = vi.hoisted(() => ({
  sent: [] as string[],
  consumer: { handler: null as Handler | null },
}));

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/redis", () => {
  const chain = { sadd: () => chain, pexpire: () => chain, exec: async () => [] };
  return { redis: { multi: () => chain, sismember: async () => 0 } };
});
vi.mock("@/lib/stream/producer", () => ({ addEvent: vi.fn(async () => "1-0") }));
vi.mock("@/lib/stream/consumer", () => ({
  consumeGroup: vi.fn(async (opts: { handler: Handler }) => {
    h.consumer.handler = opts.handler;
    return async () => {
      h.consumer.handler = null;
    };
  }),
}));
vi.mock("@/lib/notifications/factory", () => ({
  createChannel: (row: { name: string }) => ({ send: async () => void h.sent.push(row.name) }),
}));
vi.mock("@/lib/notifications/retry", () => ({ enqueueRetry: vi.fn(async () => {}) }));

const conn = await connectScratchServer();

const event = (fields: Record<string, unknown>) => ({ title: "t", message: "m", ...fields }) as BusEvent;
const deploy = (appId: string) => event({ type: "deploy.failed", appId, projectName: "x", deploymentId: "d1" });
const hostAlert = event({
  type: "alert.fired",
  alerts: [{ type: "host.memory", about: "host", severity: "critical", title: "Memory", detail: "d" }],
});
const update = event({ type: "system.update-available", remoteHead: "b", localHead: "a" });

describe.skipIf(!conn)("channel project filters on Postgres", { timeout: MIGRATE_TIMEOUT }, () => {
  const dbName = scratchName("channel_filter");
  let sql: ReturnType<typeof postgres>;
  let consumer: typeof import("@/lib/notifications/stream-consumer");
  let dispatch: typeof import("@/lib/notifications/dispatch");
  let channels: typeof import("@/lib/notifications/channels");

  beforeAll(async () => {
    const url = await conn!.create(dbName);
    expect((await runMigrate(url)).code).toBe(0);
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_MASTER_KEY = "e".repeat(64);
    sql = postgres(url, { max: 1, onnotice: () => {} });
    await sql`insert into organization (id, name, slug) values ('org1', 'Org', 'org'), ('org2', 'Other', 'other')`;
    await sql`insert into project (id, organization_id, name, display_name) values
      ('shop', 'org1', 'shop', 'Shop'), ('blog', 'org1', 'blog', 'Blog'), ('gone', 'org1', 'gone', 'Gone'),
      ('elsewhere', 'org2', 'elsewhere', 'Elsewhere')`;
    await sql`insert into app (id, organization_id, project_id, name, display_name) values
      ('shop-web', 'org1', 'shop', 'shop-web', 'Shop web'), ('blog-web', 'org1', 'blog', 'blog-web', 'Blog web')`;
    // A compose child whose own project column is stale; its parent's project wins.
    await sql`insert into app (id, organization_id, project_id, name, display_name, parent_app_id, compose_service) values
      ('shop-worker', 'org1', 'blog', 'shop-worker', 'Shop worker', 'shop-web', 'worker')`;
    await sql`insert into notification_channel (id, organization_id, name, type, config, project_ids) values
      ('c-all', 'org1', 'all', 'email', '{}', '{}'),
      ('c-shop', 'org1', 'shop', 'email', '{}', '{shop,gone}'),
      ('c-blog', 'org1', 'blog', 'email', '{}', '{blog}'),
      ('c-gone', 'org1', 'gone', 'email', '{}', '{gone}')`;
    await sql`delete from project where id = 'gone'`;
    consumer = await import("@/lib/notifications/stream-consumer");
    dispatch = await import("@/lib/notifications/dispatch");
    channels = await import("@/lib/notifications/channels");
    await consumer.startNotificationConsumer();
  }, MIGRATE_TIMEOUT);

  afterAll(async () => {
    await consumer?.stopNotificationConsumer();
    await sql?.end({ timeout: 1 });
    const g = globalThis as unknown as { vardoPgClient?: ReturnType<typeof postgres> };
    await g.vardoPgClient?.end({ timeout: 1 });
    await conn!.dropAll();
  }, MIGRATE_TIMEOUT);

  beforeEach(() => {
    h.sent.length = 0;
  });

  async function deliver(e: BusEvent): Promise<string[]> {
    await h.consumer.handler!("stream:events:org1", { id: "1-0", fields: { payload: JSON.stringify(e) } });
    return [...h.sent].sort();
  }

  it("sends a project's events to its channels and unfiltered ones only", async () => {
    expect(await deliver(deploy("shop-web"))).toEqual(["all", "shop"]);
    h.sent.length = 0;
    expect(await deliver(deploy("blog-web"))).toEqual(["all", "blog"]);
  });

  it("resolves a compose child through its parent's project", async () => {
    expect(await deliver(deploy("shop-worker"))).toEqual(["all", "shop"]);
  });

  it("sends host alerts and update notices to every channel", async () => {
    expect(await deliver(hostAlert)).toEqual(["all", "blog", "gone", "shop"]);
    h.sent.length = 0;
    expect(await deliver(update)).toEqual(["all", "blog", "gone", "shop"]);
  });

  it("sends an event whose app is gone to every channel", async () => {
    expect(await deliver(deploy("deleted-app"))).toEqual(["all", "blog", "gone", "shop"]);
  });

  it("filters on the direct path too", async () => {
    await consumer.stopNotificationConsumer();
    try {
      dispatch.emit("org1", deploy("blog-web"));
      await vi.waitFor(() => expect(h.sent.length).toBe(2));
      await new Promise((r) => setTimeout(r, 50));
      expect([...h.sent].sort()).toEqual(["all", "blog"]);
    } finally {
      await consumer.startNotificationConsumer();
    }
  });

  it("refuses projects outside the org", async () => {
    const input = channels.channelCreateSchema.parse({
      name: "x",
      type: "email",
      config: { recipients: ["ops@example.com"] },
      projectIds: ["shop", "elsewhere"],
    });
    await expect(channels.createChannelRow("org1", input)).rejects.toThrow("Project not found: elsewhere");
    await expect(channels.updateChannelRow("org1", "c-blog", { projectIds: ["gone"] })).rejects.toThrow(
      "Project not found: gone",
    );
    const updated = await channels.updateChannelRow("org1", "c-blog", channels.channelUpdateSchema.parse({ projectIds: ["shop", "shop"] }));
    expect(updated?.projectIds).toEqual(["shop"]);
    await channels.updateChannelRow("org1", "c-blog", { projectIds: ["blog"] });
  });
});

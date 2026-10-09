import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Every emit lands on the org's Redis stream and also runs the direct dispatch hook.
// One event must reach each channel exactly once, whichever path delivers it.

type Entry = { key: string; payload: string };
type Handler = (key: string, entry: { id: string; fields: Record<string, string> }) => Promise<void>;

const { stream, send, consumer } = vi.hoisted(() => ({
  stream: [] as Entry[],
  send: vi.fn(async () => {}),
  consumer: { handler: null as Handler | null, keys: [] as string[] },
}));

vi.mock("@/lib/db", () => ({
  db: {
    query: {
      organizations: { findMany: vi.fn(async () => [{ id: "org-1" }]) },
      notificationChannels: {
        findMany: vi.fn(async () => [
          { id: "ch-1", name: "Ops email", type: "email", enabled: true, subscribedEvents: [] },
        ]),
      },
      memberships: { findMany: vi.fn(async () => [{ userId: "user-1" }]) },
      userNotificationPreferences: { findMany: vi.fn(async () => []) },
    },
    insert: () => ({ values: async () => {} }),
  },
}));
vi.mock("@/lib/stream/producer", () => ({
  addEvent: vi.fn(async (orgId: string, event: unknown) => {
    stream.push({ key: `stream:events:${orgId}`, payload: JSON.stringify(event) });
    return `${stream.length}-0`;
  }),
}));
vi.mock("@/lib/stream/consumer", () => ({
  consumeGroup: vi.fn(async (opts: { handler: Handler; keys: string[] }) => {
    consumer.handler = opts.handler;
    consumer.keys = opts.keys;
    return async () => {
      consumer.handler = null;
    };
  }),
}));
vi.mock("@/lib/notifications/factory", () => ({ createChannel: () => ({ send }) }));
vi.mock("@/lib/notifications/retry", () => ({ enqueueRetry: vi.fn(async () => {}) }));

import { emit } from "@/lib/notifications/dispatch";
import { addEvent } from "@/lib/stream/producer";
import {
  startNotificationConsumer,
  stopNotificationConsumer,
} from "@/lib/notifications/stream-consumer";
import type { BusEvent } from "@/lib/bus/events";

const deploySuccess: BusEvent = {
  type: "deploy.success",
  title: "Deploy successful: web",
  message: "web was deployed",
  projectName: "web",
  appId: "app-1",
  deploymentId: "dep-1",
  duration: "3s",
};

const deployStatus: BusEvent = {
  type: "deploy.status",
  title: "Deploy succeeded",
  message: "done",
  appId: "app-1",
  deploymentId: "dep-1",
  status: "active",
  success: true,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Feeds the running consumer the entries on streams it reads. */
async function drainStream() {
  for (const [i, entry] of stream.entries()) {
    if (!consumer.keys.includes(entry.key)) continue;
    await consumer.handler?.(entry.key, { id: `${i + 1}-0`, fields: { payload: entry.payload } });
  }
  stream.length = 0;
}

beforeEach(() => {
  stream.length = 0;
  send.mockClear();
});

afterEach(async () => {
  await stopNotificationConsumer();
});

describe("notification dispatch", () => {
  it("sends once per channel when the stream consumer is running", async () => {
    await startNotificationConsumer();

    emit("org-1", deploySuccess);
    await flush();
    await drainStream();
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends once through the direct hook when the consumer isn't running", async () => {
    emit("org-1", deploySuccess);
    await flush();
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends once through the direct hook for an org the consumer isn't reading", async () => {
    await startNotificationConsumer();

    emit("org-2", deploySuccess);
    await flush();
    await drainStream();
    await flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never sends deploy.status to a channel", async () => {
    await startNotificationConsumer();
    await addEvent("org-1", deployStatus);
    emit("org-1", deployStatus);
    await flush();
    await drainStream();
    await flush();

    await stopNotificationConsumer();
    emit("org-1", deployStatus);
    await flush();
    await flush();

    expect(send).not.toHaveBeenCalled();
  });
});

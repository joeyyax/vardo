import { beforeEach, describe, expect, it, vi } from "vitest";

// Scripted drizzle: each select, insert and update pops its next result.
const script = vi.hoisted(() => ({
  selects: [] as unknown[][],
  inserts: [] as unknown[][],
  updates: [] as unknown[][],
  writes: [] as { op: string; values?: unknown; set?: unknown }[],
}));

vi.mock("@/lib/db", () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "where", "limit", "onConflictDoNothing", "set"]) c[m] = () => c;
    c.returning = async () => rows();
    c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows()).then(resolve);
    return c;
  };
  return {
    db: {
      select: () => chain(() => script.selects.shift() ?? []),
      insert: () => ({
        values: (values: unknown) => {
          script.writes.push({ op: "insert", values });
          return chain(() => script.inserts.shift() ?? []);
        },
      }),
      update: () => ({
        set: (set: unknown) => {
          script.writes.push({ op: "update", set });
          return chain(() => script.updates.shift() ?? []);
        },
      }),
    },
  };
});

const { claimable, claimNotifications, clearNotifications } = await import("@/lib/notifications/throttle");

const HOUR = 3_600_000;
const now = new Date("2026-10-09T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * HOUR);

beforeEach(() => {
  script.selects = [];
  script.inserts = [];
  script.updates = [];
  script.writes = [];
});

describe("claimable", () => {
  it("sends a subject never sent", () => {
    expect(claimable(null, "warning", now, 1)).toBe(true);
  });

  it("holds while the condition hasn't cleared", () => {
    expect(claimable({ sentAt: ago(30), clearedAt: null, severity: "warning" }, "warning", now, 1)).toBe(false);
  });

  it("sends again when it gets worse before clearing", () => {
    expect(claimable({ sentAt: ago(0.1), clearedAt: null, severity: "warning" }, "critical", now, 1)).toBe(true);
    expect(claimable({ sentAt: ago(0.1), clearedAt: null, severity: "critical" }, "warning", now, 1)).toBe(false);
  });

  it("re-arms only after clearing and minHours past the last send", () => {
    expect(claimable({ sentAt: ago(0.5), clearedAt: ago(0.2), severity: "warning" }, "warning", now, 1)).toBe(false);
    expect(claimable({ sentAt: ago(1), clearedAt: ago(0.2), severity: "warning" }, "warning", now, 1)).toBe(true);
  });
});

describe("claimNotifications", () => {
  it("inserts a new subject once, even when asked twice", async () => {
    script.selects = [[]];
    script.inserts = [[{ about: "host" }]];
    const claims = await claimNotifications("org1", "host.memory", [
      { about: "host", severity: "warning", detail: {} },
      { about: "host", severity: "warning", detail: {} },
    ], 1, now);
    expect(claims).toEqual([{ about: "host", previous: null }]);
    expect(script.writes.filter((w) => w.op === "insert")).toHaveLength(1);
  });

  it("loses to a concurrent claim on the same row", async () => {
    script.selects = [[]];
    script.inserts = [[]];
    expect(await claimNotifications("org1", "host.memory", [{ about: "host", severity: "warning", detail: {} }], 1, now)).toEqual([]);
  });

  it("re-arms a cleared row and keeps the previous state", async () => {
    const previous = { sentAt: ago(2), clearedAt: ago(1), severity: "warning" };
    script.selects = [[previous]];
    script.updates = [[{ about: "host" }]];
    const claims = await claimNotifications("org1", "host.memory", [{ about: "host", severity: "critical", detail: { title: "x" } }], 1, now);
    expect(claims).toEqual([{ about: "host", previous }]);
    expect(script.writes[0].set).toMatchObject({ sentAt: now, clearedAt: null, severity: "critical" });
  });

  it("skips a subject still holding at the same severity", async () => {
    script.selects = [[{ sentAt: ago(0.1), clearedAt: null, severity: "warning" }]];
    expect(await claimNotifications("org1", "host.memory", [{ about: "host", severity: "warning", detail: {} }], 1, now)).toEqual([]);
    expect(script.writes).toHaveLength(0);
  });
});

describe("clearNotifications", () => {
  it("returns the rows that stopped holding", async () => {
    const row = { about: "app1", severity: "warning", sentAt: ago(1), detail: { title: "x" } };
    script.updates = [[row]];
    expect(await clearNotifications("org1", "app.unhealthy", ["app2"], now)).toEqual([row]);
    expect(script.writes[0].set).toEqual({ clearedAt: now });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/system-settings", () => ({ getInstanceConfig: async () => null, getSystemSettingRaw: async () => null }));

type Row = Record<string, unknown>;
const data = vi.hoisted(() => ({ tables: new Map<unknown, { rows: Row[]; key: string }>() }));

// Rows come back in stored order unless the query orders them, like Postgres after an update.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const { rows, key } = data.tables.get(table)!;
        const ordered = () => Promise.resolve([...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key]))));
        const query = { orderBy: ordered, then: (ok: (r: Row[]) => unknown) => Promise.resolve(rows).then(ok) };
        return { ...query, where: () => query };
      },
    }),
  },
}));

import { apps, domains } from "@/lib/db/schema";
import { loadGuardApps } from "@/lib/probe-guard/sync";
import { writeGuardFile } from "@/lib/probe-guard/traefik-file";

const on = { enabled: true };
const appRows = [
  { id: "app-b", parentAppId: null, probeGuard: on },
  { id: "app-a", parentAppId: null, probeGuard: on },
  { id: "app-a-web", parentAppId: "app-a", probeGuard: null },
];
const domainRows = [
  { appId: "app-a-web", domain: "z.example.com" },
  { appId: "app-b", domain: "b.example.com" },
  { appId: "app-a", domain: "a.example.com" },
];

function stored(order: number[]) {
  data.tables.set(apps, { rows: order.map((i) => appRows[i]), key: "id" });
  data.tables.set(domains, { rows: order.map((i) => domainRows[i]), key: "domain" });
}

describe("loadGuardApps", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-order-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns apps and hosts in the same order however rows are stored", async () => {
    stored([0, 1, 2]);
    const first = await loadGuardApps();
    stored([2, 0, 1]);
    const second = await loadGuardApps();
    expect(second).toEqual(first);
    expect(first.map((a) => [a.id, a.hosts])).toEqual([
      ["app-a", ["a.example.com", "z.example.com"]],
      ["app-b", ["b.example.com"]],
    ]);
  });

  it("leaves the file alone when only the row order changed", async () => {
    const state = async () => ({ key: "a".repeat(64), apps: await loadGuardApps(), bannedIps: [], trapPaths: ["/admin-backup/"], markers: [] });
    stored([0, 1, 2]);
    expect(await writeGuardFile(await state(), dir)).toBe("written");
    stored([1, 2, 0]);
    expect(await writeGuardFile(await state(), dir)).toBe("unchanged");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { banReasonLine, guardSummary, probeSummary, type BanDetail } from "@/lib/probe-guard/summary";
import { banDetailFrom, summarizeProbePaths, type DetailEvent } from "@/lib/probe-guard/ban-detail";
import { pathLabeler } from "@/lib/probe-guard/labels";

const IP = "203.0.113.20";
const banAt = new Date("2026-01-01T12:00:00Z");
const MIN = 60_000;

function repeat(path: string, n: number): string[] {
  return Array.from({ length: n }, () => path);
}

const probes = (paths: string[]) => paths.map((path) => ({ path, appId: null }));

describe("summarizeProbePaths", () => {
  it("counts categories and paths, most frequent first", () => {
    const paths = [...repeat("/_ignition/execute-solution", 28), ...repeat("/.env", 4), ...repeat("/api/.env", 2), "/.git/config"];
    const { categories, paths: top } = summarizeProbePaths(probes(paths));
    expect(categories).toEqual([
      { label: "Laravel Ignition exploit (RCE)", count: 28 },
      { label: "env files", count: 6 },
      { label: "Git metadata", count: 1 },
    ]);
    expect(top[0]).toEqual({ path: "/_ignition/execute-solution", count: 28 });
    expect(top).toHaveLength(4);
  });

  it("caps the path list", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `/.env.${i}`);
    expect(summarizeProbePaths(probes(paths), undefined, 10).paths).toHaveLength(10);
  });

  it("files an app's turn-away entries under their own labels", () => {
    const labelFor = pathLabeler(new Map([["app1", [{ kind: "prefix" as const, value: "/telescope", template: "laravel" }]]]));
    expect(summarizeProbePaths([{ path: "/telescope", appId: "app1" }], labelFor).categories).toEqual([{ label: "Laravel", count: 1 }]);
  });

  it("files unmatched paths under other paths", () => {
    expect(summarizeProbePaths(probes(["/hello"])).categories).toEqual([{ label: "other paths", count: 1 }]);
  });
});

describe("probeSummary", () => {
  it("shows up to three categories with counts", () => {
    expect(probeSummary([{ label: "Laravel Ignition exploit (RCE)", count: 28 }, { label: "env files", count: 6 }])).toBe(
      "Tried Laravel Ignition exploit (RCE) ×28, env files ×6",
    );
  });

  it("folds the rest into +N more", () => {
    const cats = ["env files", "Git metadata", "SSH keys", "phpMyAdmin", "SQL dumps"].map((label, i) => ({ label, count: 10 - i }));
    expect(probeSummary(cats)).toBe("Tried env files ×10, Git metadata ×9, SSH keys ×8, +2 more");
  });

  it("groups thousands", () => {
    expect(probeSummary([{ label: "env files", count: 1200 }])).toBe("Tried env files ×1,200");
  });
});

describe("banReasonLine", () => {
  const detail = (over: Partial<BanDetail> = {}): BanDetail => ({ categories: [], paths: [], trapPath: null, ...over });

  it("names what a threshold ban probed and the app", () => {
    const line = banReasonLine({
      reason: "threshold",
      originName: null,
      appName: "Docs",
      detail: detail({ categories: [{ label: "Laravel Ignition exploit (RCE)", count: 28 }, { label: "env files", count: 6 }] }),
    });
    expect(line).toBe("Tried Laravel Ignition exploit (RCE) ×28, env files ×6 on Docs");
  });

  it("falls back when no probes were recorded", () => {
    expect(banReasonLine({ reason: "threshold", originName: null, detail: null })).toBe("Repeated probes");
  });

  it("names the trap path", () => {
    expect(banReasonLine({ reason: "trap", originName: null, appName: "Shop", detail: detail({ trapPath: "/admin-backup/" }) })).toBe(
      "Fetched trap path /admin-backup/ on Shop",
    );
    expect(banReasonLine({ reason: "trap", originName: null })).toBe("Fetched a trap path");
  });

  it("covers canary and mesh bans", () => {
    expect(banReasonLine({ reason: "canary", originName: null })).toBe("Used a decoy credential");
    expect(banReasonLine({ reason: "mesh", originName: "edge-2" })).toBe("Shared by edge-2");
    expect(banReasonLine({ reason: "mesh", originName: null })).toBe("Shared by a linked instance");
  });
});

describe("banDetailFrom", () => {
  const ev = (path: string, minutesBefore: number, over: Partial<DetailEvent> = {}): DetailEvent => ({
    ip: IP,
    kind: "probe",
    path,
    appId: null,
    createdAt: new Date(banAt.getTime() - minutesBefore * MIN),
    ...over,
  });

  it("uses only this address's probes within the window before the ban", () => {
    const events = [
      ev("/.env", 1),
      ev("/.env", 2),
      ev("/.git/config", 3),
      ev("/.env", 30),
      ev("/.env", 1, { ip: "203.0.113.21" }),
      ev("/private/db.sql", 1, { kind: "trap" }),
    ];
    const d = banDetailFrom({ ip: IP, createdAt: banAt }, events, 10 * MIN);
    expect(d.categories).toEqual([{ label: "env files", count: 2 }, { label: "Git metadata", count: 1 }]);
    expect(d.trapPath).toBe("/private/db.sql");
  });
});

describe("guardSummary", () => {
  it("adds permanent bans when there are some", () => {
    expect(guardSummary({ probes: 142, bans: 3, traps: 0, permanent: 2 })).toBe(
      "142 probes turned away this week, 3 IPs banned, 2 permanent bans",
    );
    expect(guardSummary({ probes: 0, bans: 0, traps: 0, permanent: 1 })).toBe("No probes turned away this week, 1 permanent ban");
    expect(guardSummary({ probes: 5, bans: 1, traps: 0, permanent: 0 })).toBe("5 probes turned away this week, 1 IP banned");
  });
});

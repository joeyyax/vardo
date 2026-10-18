// The Apps table's rules: each row's state, filtering, grouping, sorting and the header sentence.

import type { AppRow, AppsSnapshot } from "@/lib/admin-apps/types";
import { stageHead } from "@/lib/ui/deploy-stage";
import { currentStage, isLive, waitsForBuilder } from "../pipeline/timeline";

export type GroupBy = "org" | "project" | "none";
export type SortKey = "name" | "cpu" | "memory" | "network" | "uptime" | "deploy";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

/** Memory at or past this share of its limit reads as near it. */
export const NEAR_LIMIT = 0.85;

export type RowTone = "issue" | "warn" | "active" | "stopped" | "neutral";

export function nearLimit(a: Pick<AppRow, "memory" | "memoryLimit">): boolean {
  return a.memory !== null && a.memoryLimit !== null && a.memoryLimit > 0 && a.memory / a.memoryLimit >= NEAR_LIMIT;
}

const deploying = (a: AppRow) => !!a.deploy && isLive(a.deploy);

export function rowTone(a: AppRow): RowTone {
  if (a.down || a.status === "error") return "issue";
  if (a.deploy && waitsForBuilder(a.deploy)) return "warn";
  if (deploying(a)) return "active";
  if (a.status === "stopped" || a.status === "missing") return "stopped";
  return "neutral";
}

/** The line under the name: what's happening, else where it lives. */
export function subLine(a: AppRow, group: GroupBy): { text: string; tone: "warn" | "issue" | null } {
  if (a.down) return { text: "Down", tone: "issue" };
  if (a.status === "error") return { text: "Crashed", tone: "issue" };
  if (a.deploy && deploying(a)) {
    const stage = currentStage(a.deploy);
    return { text: stageHead(stage, { builder: a.deploy.builderName }), tone: stage === "wait" ? "warn" : stage === "rollingBack" ? "issue" : null };
  }
  const where = group === "org" ? a.projectName : group === "project" ? a.orgName : [a.orgName, a.projectName].filter(Boolean).join(" · ");
  const state = a.status === "stopped" ? "Stopped" : a.status === "missing" ? "No container" : null;
  return { text: [where, state].filter(Boolean).join(" · "), tone: null };
}

export function filterApps(apps: AppRow[], q: string): AppRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return apps;
  return apps.filter((a) => [a.name, a.slug, a.orgName, a.projectName ?? ""].some((s) => s.toLowerCase().includes(needle)));
}

const sortValue: Record<SortKey, (a: AppRow) => number | string | null> = {
  name: (a) => a.name.toLowerCase(),
  cpu: (a) => a.cpu,
  memory: (a) => a.memory,
  network: (a) => (a.rx === null && a.tx === null ? null : (a.rx ?? 0) + (a.tx ?? 0)),
  uptime: (a) => a.uptime,
  deploy: (a) => a.lastDeploy?.at ?? null,
};

/** Sorted copy. Missing values sink to the bottom either way; ties fall back to name. */
export function sortApps(apps: AppRow[], sort: Sort): AppRow[] {
  const get = sortValue[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...apps].sort((x, y) => {
    const a = get(x);
    const b = get(y);
    if (a === null && b !== null) return 1;
    if (b === null && a !== null) return -1;
    if (a !== null && b !== null && a !== b) return (a < b ? -1 : 1) * sign;
    return x.name.localeCompare(y.name);
  });
}

/** Numbers start high-first; names A to Z. */
export const firstDir = (key: SortKey): Sort["dir"] => (key === "name" ? "asc" : "desc");

export type Group = { key: string; name: string | null; apps: AppRow[]; memory: number | null };

/** Groups biggest first, then by name; one unnamed group for None. */
export function groupApps(apps: AppRow[], by: GroupBy, sort: Sort): Group[] {
  const memoryOf = (list: AppRow[]) => (list.some((a) => a.memory !== null) ? list.reduce((s, a) => s + (a.memory ?? 0), 0) : null);
  if (by === "none") return [{ key: "all", name: null, apps: sortApps(apps, sort), memory: memoryOf(apps) }];
  const groups = new Map<string, { name: string; apps: AppRow[] }>();
  for (const a of apps) {
    const key = by === "org" ? a.orgId : `${a.orgId}/${a.projectName ?? ""}`;
    const name = by === "org" ? a.orgName : (a.projectName ?? "No project");
    const g = groups.get(key) ?? { name, apps: [] };
    g.apps.push(a);
    groups.set(key, g);
  }
  return [...groups]
    .map(([key, g]) => ({ key, name: g.name, apps: sortApps(g.apps, sort), memory: memoryOf(g.apps) }))
    .sort((x, y) => y.apps.length - x.apps.length || x.name.localeCompare(y.name));
}

/** "19 apps. 6 deploying, 1 near its memory limit." */
export function summarize(s: Pick<AppsSnapshot, "apps">): string {
  const n = s.apps.length;
  if (n === 0) return "No apps on this instance yet.";
  const down = s.apps.filter((a) => a.down || a.status === "error").length;
  const waiting = s.apps.filter((a) => a.deploy && waitsForBuilder(a.deploy)).length;
  const live = s.apps.filter((a) => deploying(a)).length;
  const near = s.apps.filter(nearLimit).length;
  const parts = [
    down ? `${down} down` : null,
    live ? `${live} deploying${waiting ? ` (${waiting} waiting for a builder)` : ""}` : null,
    near ? `${near} near ${near === 1 ? "its" : "their"} memory limit` : null,
  ].filter(Boolean);
  const head = `${n} ${n === 1 ? "app" : "apps"}.`;
  return parts.length ? `${head} ${parts.join(", ")}.` : `${head} Nothing needs attention.`;
}

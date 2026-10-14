// The status chip by the branding: what's wrong with Vardo itself, worst first. No React.

import type { AttentionRow } from "@/lib/ui/attention";

/** No worker beats while deploys need one. `since` is its last beat; `queuedInstance` is for admins only. */
export type WorkerOutage = { since: string | null; queued: number; queuedInstance: number | null };

/** Vardo updating or restarting, from the attention row. */
export type VardoUpdating = { name: string; href?: string };

export type SystemProblem =
  | ({ kind: "worker" } & WorkerOutage)
  | ({ kind: "updating" } & VardoUpdating);

/** Every problem that applies, worst first: a missing worker strands deploys, an update clears itself. */
export function systemProblems(worker: WorkerOutage | null, updating: VardoUpdating | null): SystemProblem[] {
  return [...(worker ? [{ kind: "worker" as const, ...worker }] : []), ...(updating ? [{ kind: "updating" as const, ...updating }] : [])];
}

/** The chip's words: the full label, and the short one for a phone. */
export function chipLabel(problem: SystemProblem): { full: string; short: string } {
  if (problem.kind === "worker") {
    return { full: problem.queued > 0 ? `Worker offline · ${problem.queued} queued` : "Worker offline", short: "Worker offline" };
  }
  const full = problem.name.replace(/^Updating Vardo\b/, "Updating").replace(/…$/, "");
  return { full, short: full.split(" ")[0] };
}

export const WORKER_OFFLINE_ROW_KEY = "worker-offline";

/** The missing worker as an attention row, so the chip follows the attention poll. */
export function workerOfflineRow(outage: WorkerOutage): AttentionRow {
  return {
    key: WORKER_OFFLINE_ROW_KEY,
    label: "Worker offline",
    tone: "activity",
    items: [{ id: WORKER_OFFLINE_ROW_KEY, name: "Worker offline", detail: workerLines(outage).join(" ") || undefined, since: outage.since ?? undefined }],
    worker: outage,
  };
}

/** The org's rows without the worker row, and the outage it carries. */
export function takeWorkerRow(rows: AttentionRow[]): { rows: AttentionRow[]; worker: WorkerOutage | null } {
  const row = rows.find((r) => r.key === WORKER_OFFLINE_ROW_KEY);
  return row ? { rows: rows.filter((r) => r !== row), worker: row.worker ?? null } : { rows, worker: null };
}

const deploys = (n: number) => `${n} ${n === 1 ? "deploy" : "deploys"}`;

/** What follows "Worker offline since …": the org's queue, then the instance's for an admin when it holds more. */
export function workerLines({ queued, queuedInstance }: WorkerOutage): string[] {
  const lines = queued > 0 ? [`${deploys(queued)} queued.`] : [];
  if (queuedInstance !== null && queuedInstance > queued) {
    lines.push(queued > 0 ? `${queuedInstance} across the instance.` : `${deploys(queuedInstance)} queued across the instance.`);
  }
  return lines;
}

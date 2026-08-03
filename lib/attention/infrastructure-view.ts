// ---------------------------------------------------------------------------
// Infrastructure view state
//
// A self-deploy replaces the frontend, so the poll that reports it is the poll
// that stops answering. This turns the last known payload plus the current
// connection state into rows, so the gap reads as "restarting" rather than a
// frozen row, and the deploy visibly resolves once the new instance answers.
//
// Pure and framework-free: the hook owns timers, this owns the meaning.
// ---------------------------------------------------------------------------

import type { AttentionRow } from "@/lib/ui/attention";

/** Poll cadence while nothing is happening. */
export const INFRA_POLL_IDLE_MS = 20_000;

/** Poll cadence while a deploy, an outage or a pending resolution is in play. */
export const INFRA_POLL_ACTIVE_MS = 4_000;

/** Failed polls tolerated before the bar admits it cannot reach the instance. */
export const INFRA_FAILURES_BEFORE_UNREACHABLE = 3;

/** How long the finished-updating row stays up before clearing itself. */
export const INFRA_RESOLVED_MS = 20_000;

/** Window event asking the bar to re-check now, dispatched on any bus event. */
export const INFRA_RECHECK_EVENT = "vardo:infrastructure-recheck";

export type InfrastructureView = {
  /** Rows from the last successful poll. */
  rows: AttentionRow[];
  /** Whether that poll reported a Vardo self-deploy. */
  selfDeploy: boolean;
  /** Consecutive failed polls. */
  failures: number;
  /** When a self-deploy we were watching stopped being reported. */
  resolvedAt: number | null;
};

export function initialInfrastructureView(): InfrastructureView {
  return { rows: [], selfDeploy: false, failures: 0, resolvedAt: null };
}

/** Fold a successful poll into the view. */
export function applyInfrastructurePayload(
  state: InfrastructureView,
  payload: { rows: AttentionRow[]; selfDeploy: boolean },
  now: number,
): InfrastructureView {
  const finished = state.selfDeploy && !payload.selfDeploy;
  return {
    rows: payload.rows,
    selfDeploy: payload.selfDeploy,
    failures: 0,
    resolvedAt: payload.selfDeploy ? null : finished ? now : state.resolvedAt,
  };
}

/** Fold a failed poll into the view. Keeps the last payload — it is still the best guess. */
export function applyInfrastructureFailure(state: InfrastructureView): InfrastructureView {
  return { ...state, failures: state.failures + 1 };
}

/** True once enough polls have failed in a row to say so out loud. */
export function isUnreachable(state: InfrastructureView): boolean {
  return state.failures >= INFRA_FAILURES_BEFORE_UNREACHABLE;
}

/**
 * What to render. Unreachable replaces the stale rows rather than adding to
 * them — nothing we last read is worth asserting once the instance stopped
 * answering.
 */
export function infrastructureViewRows(state: InfrastructureView, now: number): AttentionRow[] {
  if (isUnreachable(state)) {
    return [state.selfDeploy ? restartingRow() : unreachableRow()];
  }

  const rows = [...state.rows];
  if (state.resolvedAt !== null && now - state.resolvedAt < INFRA_RESOLVED_MS) {
    rows.push(resolvedRow());
  }
  return rows;
}

/** Milliseconds until the next poll. */
export function infrastructurePollMs(state: InfrastructureView): number {
  const busy = state.selfDeploy || state.failures > 0 || state.resolvedAt !== null;
  return busy ? INFRA_POLL_ACTIVE_MS : INFRA_POLL_IDLE_MS;
}

function restartingRow(): AttentionRow {
  return {
    key: "vardo-restarting",
    label: "Vardo restarting",
    tone: "activity",
    items: [{ id: "vardo-restarting", name: "Vardo", detail: "Reconnecting" }],
    footer: "The update replaced the console. This page reconnects on its own.",
  };
}

function unreachableRow(): AttentionRow {
  return {
    key: "vardo-unreachable",
    label: "Vardo unreachable",
    tone: "error",
    items: [{ id: "vardo-unreachable", name: "Vardo", detail: "Not responding" }],
    footer: "The console stopped answering. This page keeps trying.",
  };
}

function resolvedRow(): AttentionRow {
  return {
    key: "vardo-updated",
    label: "Vardo updated",
    tone: "activity",
    items: [{ id: "vardo-updated", name: "Vardo", detail: "Back up" }],
    footer: "The update finished. Reload if anything on this page looks stale.",
  };
}

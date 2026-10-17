// Alert damping: a state must hold before anyone hears about it, a monitor that keeps changing gets one "flapping" notice,
// and warnings (degraded and the disagreement readings) show in the console without notifying.

export const HOLD_MS = 3 * 60_000;
export const HOLD_EVALUATIONS = 3;
export const FLAP_WINDOW_MS = 30 * 60_000;
export const FLAP_CHANGES = 3;
export const SETTLE_MS = 15 * 60_000;

export type AlertState = "up" | "degraded" | "down";

/** What the monitor looks like now. `key` tells readings apart: a new reading is a new state. */
export type Observation = { state: AlertState; key: string };

export type DampMemory = {
  candidate: (Observation & { since: number; evals: number }) | null;
  /** What the open incident reflects. Null when none is open; undefined until the first answer. */
  announced: Observation | null | undefined;
  /** An operator was notified about the announced state. */
  notified: boolean;
  /** When the announced state changed, in the last 30 minutes. */
  changes: number[];
  flapping: boolean;
};

export type DampAction =
  /** Open or replace the incident. `notify` sends it to the operator. */
  | { kind: "open"; state: "degraded" | "down"; key: string; notify: boolean }
  /** `stale`: nothing is known about an incident, such as after a restart; resolve any that is open and notify only then. */
  | { kind: "resolve"; notify: boolean; stale?: boolean }
  | { kind: "flapping" }
  | { kind: "settled"; state: AlertState };

export const newMemory = (): DampMemory => ({ candidate: null, announced: undefined, notified: false, changes: [], flapping: false });

export type DampOptions = {
  /** Whether a degraded state notifies. Off by default. */
  notifyWarnings?: boolean;
};

/**
 * Feeds one evaluation in. `obs` is null when the monitor has no data, which changes nothing.
 * - down and degraded are announced once they've held 3 minutes and 3 evaluations; up once it's held 3 minutes.
 * - More than 3 announced changes in 30 minutes is flapping: one notice, then silence until the state has held 15 minutes, then one notice with where it settled.
 *   States that don't hold long enough to be announced don't count.
 */
export function stepDamping(memory: DampMemory, obs: Observation | null, now: number, options: DampOptions = {}): { memory: DampMemory; actions: DampAction[] } {
  if (!obs) return { memory, actions: [] };
  const m: DampMemory = { ...memory, changes: memory.changes.filter((t) => now - t <= FLAP_WINDOW_MS) };
  const actions: DampAction[] = [];

  const prev = m.candidate;
  m.candidate = prev && prev.key === obs.key ? { ...prev, evals: prev.evals + 1 } : { ...obs, since: now, evals: 1 };
  const c = m.candidate;

  const age = now - c.since;
  const held = c.state === "up" ? age >= HOLD_MS : age >= HOLD_MS && c.evals >= HOLD_EVALUATIONS;
  const differs = c.state === "up" ? m.announced !== null : m.announced?.key !== c.key;
  const stale = held && c.state === "up" && m.announced === undefined;

  if (held && differs && !stale) m.changes = [...m.changes, now];
  if (!m.flapping && m.changes.length > FLAP_CHANGES) {
    m.flapping = true;
    actions.push({ kind: "flapping" });
  }
  let settled = false;
  if (m.flapping && age >= SETTLE_MS) {
    m.flapping = false;
    m.changes = [];
    settled = true;
    actions.push({ kind: "settled", state: c.state });
  }

  if (held && differs) {
    const quiet = m.flapping || settled;
    if (c.state === "up") {
      if (stale) actions.push({ kind: "resolve", notify: false, stale: true });
      else if (m.announced) actions.push({ kind: "resolve", notify: !quiet && m.notified });
      m.announced = null;
      m.notified = false;
    } else {
      const notify = !quiet && (c.state === "down" || !!options.notifyWarnings);
      actions.push({ kind: "open", state: c.state, key: c.key, notify });
      m.announced = { state: c.state, key: c.key };
      m.notified = m.notified || notify || (settled && c.state === "down");
    }
  } else if (settled) {
    m.notified = c.state === "up" ? false : m.notified || c.state === "down";
  }
  return { memory: m, actions };
}

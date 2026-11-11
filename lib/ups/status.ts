// UPS readings and the alert state machine: what each poll changes and which alerts fire or clear. No I/O.

export type UpsReading = {
  /** `ups.status` flags, such as OL, OB, LB, RB and CHRG. */
  flags: string[];
  status: string | null;
  /** Percent. */
  charge: number | null;
  /** Seconds. */
  runtime: number | null;
  /** Percent of capacity. */
  load: number | null;
  /** Watts. */
  realpower: number | null;
  /** Volts. */
  inputVoltage: number | null;
  testResult: string | null;
  model: string | null;
  mfr: string | null;
  vars: Record<string, string>;
};

/** Conditions that alert while they hold and clear when they stop. */
export type UpsCondition = "on-battery" | "low-battery" | "replace-battery" | "contact-lost" | "test-failed";

export type UpsState = {
  /** Polls in a row that failed. */
  failedPolls: number;
  lastPolledAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  /** The last successful reading. Kept through failed polls. */
  reading: UpsReading | null;
  /** When `OB` first showed in the current outage. */
  onBatterySince: string | null;
  /** When each active condition last alerted. */
  fired: Partial<Record<UpsCondition, string>>;
};

export type PollResult = { ok: true; reading: UpsReading } | { ok: false; error: string };

export type UpsTransition =
  | { kind: "fired"; condition: UpsCondition; repeat: boolean }
  | { kind: "cleared"; condition: UpsCondition; firedAt: string };

/** Failed polls in a row before contact counts as lost. */
export const LOST_CONTACT_POLLS = 4;

/** A condition still holding alerts again after this long, as system alerts do. */
export const REFIRE_MS: Record<UpsCondition, number> = {
  "on-battery": 24 * 60 * 60_000,
  "low-battery": 24 * 60 * 60_000,
  "contact-lost": 24 * 60 * 60_000,
  "replace-battery": 7 * 24 * 60 * 60_000,
  "test-failed": 7 * 24 * 60 * 60_000,
};

export const EMPTY_STATE: UpsState = {
  failedPolls: 0,
  lastPolledAt: null,
  lastOkAt: null,
  lastError: null,
  reading: null,
  onBatterySince: null,
  fired: {},
};

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function parseFlags(status: string | undefined): string[] {
  return (status ?? "").trim().split(/\s+/).filter(Boolean).map((f) => f.toUpperCase());
}

/** A reading from a `LIST VAR` reply. */
export function readingFromVars(vars: Record<string, string>): UpsReading {
  return {
    flags: parseFlags(vars["ups.status"]),
    status: vars["ups.status"] ?? null,
    charge: num(vars["battery.charge"]),
    runtime: num(vars["battery.runtime"]),
    load: num(vars["ups.load"]),
    realpower: num(vars["ups.realpower"]),
    inputVoltage: num(vars["input.voltage"]),
    testResult: vars["ups.test.result"] ?? null,
    model: vars["ups.model"] ?? vars["device.model"] ?? null,
    mfr: vars["ups.mfr"] ?? vars["device.mfr"] ?? null,
    vars,
  };
}

/** "failed", "passed" or "neutral" for a `ups.test.result` value. */
export function testOutcome(result: string | null): "failed" | "passed" | "neutral" {
  if (!result) return "neutral";
  if (/error|fail|warning/i.test(result)) return "failed";
  if (/pass/i.test(result)) return "passed";
  return "neutral";
}

/** Whether a reading says the condition holds, doesn't, or can't tell. */
function readingHolds(condition: Exclude<UpsCondition, "contact-lost">, r: UpsReading): boolean | null {
  switch (condition) {
    case "on-battery":
      if (r.flags.includes("OB")) return true;
      return r.flags.includes("OL") ? false : null;
    case "low-battery":
      return r.flags.includes("LB");
    case "replace-battery":
      return r.flags.includes("RB");
    case "test-failed": {
      const outcome = testOutcome(r.testResult);
      return outcome === "neutral" ? null : outcome === "failed";
    }
  }
}

const READING_CONDITIONS = ["on-battery", "low-battery", "replace-battery", "test-failed"] as const;

/** The state after one poll and the alerts it fires or clears. */
export function advance(prev: UpsState | null, poll: PollResult, now: Date, lostAfter = LOST_CONTACT_POLLS): { state: UpsState; transitions: UpsTransition[] } {
  const base = prev ?? EMPTY_STATE;
  const nowIso = now.toISOString();
  const fired = { ...base.fired };
  const transitions: UpsTransition[] = [];

  const apply = (condition: UpsCondition, holds: boolean | null) => {
    if (holds === null) return;
    const at = fired[condition];
    if (holds) {
      if (at && now.getTime() - Date.parse(at) < REFIRE_MS[condition]) return;
      fired[condition] = nowIso;
      transitions.push({ kind: "fired", condition, repeat: !!at });
    } else if (at) {
      delete fired[condition];
      transitions.push({ kind: "cleared", condition, firedAt: at });
    }
  };

  if (!poll.ok) {
    const failedPolls = base.failedPolls + 1;
    apply("contact-lost", failedPolls >= lostAfter ? true : null);
    return {
      state: { ...base, failedPolls, lastPolledAt: nowIso, lastError: poll.error, fired },
      transitions,
    };
  }

  const r = poll.reading;
  apply("contact-lost", false);
  for (const condition of READING_CONDITIONS) apply(condition, readingHolds(condition, r));

  const onBattery = readingHolds("on-battery", r);
  const onBatterySince = onBattery === true ? (base.onBatterySince ?? nowIso) : onBattery === false ? null : base.onBatterySince;

  return {
    state: { failedPolls: 0, lastPolledAt: nowIso, lastOkAt: nowIso, lastError: null, reading: r, onBatterySince, fired },
    transitions,
  };
}

/** The headline state for a UPS. */
export type UpsHealth = "online" | "on-battery" | "low-battery" | "lost-contact" | "unknown";

export function upsHealth(state: UpsState | null, lostAfter = LOST_CONTACT_POLLS): UpsHealth {
  if (!state) return "unknown";
  if (state.failedPolls >= lostAfter) return "lost-contact";
  if (!state.reading) return "unknown";
  const flags = state.reading.flags;
  if (flags.includes("OB") && flags.includes("LB")) return "low-battery";
  if (flags.includes("OB")) return "on-battery";
  if (flags.includes("LB")) return "low-battery";
  if (flags.includes("OL")) return "online";
  return "unknown";
}

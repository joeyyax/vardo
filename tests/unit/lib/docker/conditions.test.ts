import { describe, it, expect } from "vitest";
import {
  evaluateConditions,
  worstCondition,
  conditionsEqual,
  CERT_OBSERVATION_STALE_MS,
  HYSTERESIS,
  MEMORY_PRESSURE_RATIO,
  MEMORY_PRESSURE_SUSTAINED_MS,
  type AppCondition,
  type ConditionInput,
  type ConditionStreaks,
} from "@/lib/docker/conditions";
import {
  CERT_EXPIRY_CRITICAL_DAYS,
  CERT_EXPIRY_THRESHOLD_DAYS,
} from "@/lib/system-alerts/cert-expiry";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function input(overrides: Partial<ConditionInput> = {}): ConditionInput {
  return {
    now: NOW,
    crashLoop: null,
    health: null,
    selfHealExhausted: false,
    memory: null,
    security: null,
    backup: null,
    cert: null,
    ...overrides,
  };
}

/** A fresh observation of a certificate expiring in `days`. */
function cert(days: number, checkedAt = NOW): NonNullable<ConditionInput["cert"]> {
  return { domain: "app.example.com", expiresAt: NOW + days * DAY, checkedAt };
}

/** The health monitor's poll interval — what a "tick" is worth in wall clock. */
const TICK = 30_000;

type State = { conditions: AppCondition[]; streaks: ConditionStreaks };

/** Tick `overrides` n times from `start`, one TICK apart, threading state through. */
function run(
  overrides: Partial<ConditionInput>,
  n: number,
  start: number,
  state: State = { conditions: [], streaks: {} },
): State & { now: number } {
  let now = start;
  for (let k = 0; k < n; k++) {
    now = start + k * TICK;
    state = evaluateConditions(input({ ...overrides, now }), state.conditions, state.streaks);
  }
  return { ...state, now };
}

describe("discrete conditions", () => {
  it("reports crash-looping on the first sample", () => {
    const { conditions } = evaluateConditions(
      input({ crashLoop: { restarts: 6, windowMs: 12 * 60_000 } }),
      [],
      {},
    );
    expect(conditions.map((c) => c.kind)).toEqual(["crash-looping"]);
    expect(conditions[0].severity).toBe("critical");
    expect(conditions[0].detail).toBe("6 restarts in 12m, never healthy");
  });

  it("clears crash-looping as soon as the signal stops", () => {
    const first = evaluateConditions(input({ crashLoop: { restarts: 6, windowMs: 60_000 } }), [], {});
    const second = evaluateConditions(input(), first.conditions, first.streaks);
    expect(second.conditions).toEqual([]);
  });

  it("reports unhealthy but not healthy or starting", () => {
    expect(evaluateConditions(input({ health: "unhealthy" }), [], {}).conditions).toHaveLength(1);
    expect(evaluateConditions(input({ health: "healthy" }), [], {}).conditions).toEqual([]);
    expect(evaluateConditions(input({ health: "starting" }), [], {}).conditions).toEqual([]);
  });

  it("reports self-heal-exhausted as critical", () => {
    const { conditions } = evaluateConditions(input({ selfHealExhausted: true }), [], {});
    expect(conditions[0]).toMatchObject({ kind: "self-heal-exhausted", severity: "critical" });
  });
});

describe("memory pressure", () => {
  const over = { memory: { usage: 95, limit: 100 } };
  const under = { memory: { usage: 37, limit: 100 } };
  const gate = HYSTERESIS["memory-pressure"]!;
  /** Ticks that span the sustained window, plus the one that opened it. */
  const sustained = MEMORY_PRESSURE_SUSTAINED_MS / TICK + 1;

  it("does not fire on a single sample over the threshold", () => {
    expect(run(over, 1, NOW).conditions).toEqual([]);
  });

  it("ignores a spike shorter than the sustained window", () => {
    const spike = run(over, sustained - 1, NOW);
    expect(spike.conditions).toEqual([]);
  });

  it("fires once the overage has held for the sustained window", () => {
    const { conditions } = run(over, sustained, NOW);
    expect(conditions.map((c) => c.kind)).toEqual(["memory-pressure"]);
    expect(conditions[0].detail).toBe("95% of memory limit");
  });

  it("dates the condition from the crossing, so the duration is the overage", () => {
    const { conditions } = run(over, sustained, NOW);
    expect(conditions[0].since).toBe(new Date(NOW).toISOString());
  });

  it("restarts the window after the reading drops back under", () => {
    const on = run(over, sustained - 1, NOW);
    const dip = run(under, 1, on.now + TICK, on);
    const again = run(over, sustained - 1, dip.now + TICK, dip);
    expect(again.conditions).toEqual([]);
  });

  it("reports the current reading while hysteresis holds it open", () => {
    const on = run(over, sustained, NOW);
    const easing = run(under, gate.clear - 1, on.now + TICK, on);
    expect(easing.conditions[0].detail).toBe("37% of memory limit, easing");
  });

  it("holds through a dip shorter than the clear streak", () => {
    const on = run(over, sustained, NOW);
    const dipping = run(under, gate.clear - 1, on.now + TICK, on);
    expect(dipping.conditions.map((c) => c.kind)).toEqual(["memory-pressure"]);
  });

  it("clears once the dip reaches the clear streak", () => {
    const on = run(over, sustained, NOW);
    const cleared = run(under, gate.clear, on.now + TICK, on);
    expect(cleared.conditions).toEqual([]);
  });

  it("clears when the reading goes away entirely", () => {
    const on = run(over, sustained, NOW);
    const gone = run({ memory: null }, gate.clear, on.now + TICK, on);
    expect(gone.conditions).toEqual([]);
  });

  it("ignores an unlimited container, where a ratio is meaningless", () => {
    expect(run({ memory: { usage: 8e9, limit: 0 } }, sustained, NOW).conditions).toEqual([]);
  });

  it("fires exactly at the threshold", () => {
    const atLimit = { memory: { usage: MEMORY_PRESSURE_RATIO * 100, limit: 100 } };
    expect(run(atLimit, sustained, NOW).conditions).toHaveLength(1);
  });
});

describe("since", () => {
  it("is preserved across ticks so duration is honest", () => {
    const first = evaluateConditions(input({ health: "unhealthy" }), [], {});
    const later = evaluateConditions(
      { ...input({ health: "unhealthy" }), now: NOW + 600_000 },
      first.conditions,
      first.streaks,
    );
    expect(later.conditions[0].since).toBe(first.conditions[0].since);
  });

  it("resets after the condition clears and returns", () => {
    const first = evaluateConditions(input({ health: "unhealthy" }), [], {});
    const gone = evaluateConditions(input(), first.conditions, first.streaks);
    const again = evaluateConditions(
      { ...input({ health: "unhealthy" }), now: NOW + 600_000 },
      gone.conditions,
      gone.streaks,
    );
    expect(again.conditions[0].since).not.toBe(first.conditions[0].since);
  });
});

describe("multiple conditions", () => {
  const both = {
    crashLoop: { restarts: 5, windowMs: 300_000 },
    memory: { usage: 99, limit: 100 },
  };
  const sustained = MEMORY_PRESSURE_SUSTAINED_MS / TICK + 1;

  it("reports crash-looping and memory pressure together, critical first", () => {
    const { conditions } = run(both, sustained, NOW);
    expect(conditions.map((c) => c.kind)).toEqual(["crash-looping", "memory-pressure"]);
  });

  it("worstCondition picks the highest severity", () => {
    const { conditions } = run(both, sustained, NOW);
    expect(worstCondition(conditions)?.kind).toBe("crash-looping");
  });

  it("worstCondition is null when nothing is wrong", () => {
    expect(worstCondition([])).toBeNull();
  });
});

describe("conditionsEqual", () => {
  const base: AppCondition[] = [
    { kind: "unhealthy", severity: "warning", since: "a", detail: "Healthcheck failing" },
  ];

  it("ignores since, which changes nothing for a reader", () => {
    expect(conditionsEqual(base, [{ ...base[0], since: "b" }])).toBe(true);
  });

  it("catches a changed detail, so a climbing percentage still writes", () => {
    expect(conditionsEqual(base, [{ ...base[0], detail: "different" }])).toBe(false);
  });

  it("catches a length change", () => {
    expect(conditionsEqual(base, [])).toBe(false);
  });
});

describe("security findings", () => {
  it("is critical when the latest scan has critical findings", () => {
    const { conditions } = evaluateConditions(
      input({ security: { critical: 3, warning: 5 } }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({
      kind: "security-findings",
      severity: "critical",
      detail: "3 critical findings",
    });
  });

  it("is a warning when only warnings were found", () => {
    const { conditions } = evaluateConditions(
      input({ security: { critical: 0, warning: 2 } }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({ severity: "warning", detail: "2 warnings" });
  });

  it("is absent on a clean scan", () => {
    expect(evaluateConditions(input({ security: { critical: 0, warning: 0 } }), [], {}).conditions)
      .toEqual([]);
  });
});

describe("backup coverage", () => {
  it("flags an app with volumes and no backup job", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: true, configured: false, lastRunAt: null } }),
      [],
      {},
    );
    expect(conditions.map((c) => c.kind)).toEqual(["backup-missing"]);
  });

  it("leaves a stateless app alone — it has nothing to lose", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: false, configured: false, lastRunAt: null } }),
      [],
      {},
    );
    expect(conditions).toEqual([]);
  });

  it("flags a configured job that has never run", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: true, configured: true, lastRunAt: null } }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({ kind: "backup-stale", detail: "Backup job has never run" });
  });

  it("flags a job older than the stale window", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: true, configured: true, lastRunAt: NOW - 3 * 24 * 3600_000 } }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({ kind: "backup-stale", detail: "Last backup 3 days ago" });
  });

  it("stays quiet on a recent backup", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: true, configured: true, lastRunAt: NOW - 3600_000 } }),
      [],
      {},
    );
    expect(conditions).toEqual([]);
  });

  it("does not report missing and stale at once", () => {
    const { conditions } = evaluateConditions(
      input({ backup: { hasVolumes: true, configured: true, lastRunAt: null } }),
      [],
      {},
    );
    expect(conditions.map((c) => c.kind)).not.toContain("backup-missing");
  });
});

describe("certificate expiry", () => {
  it("stays quiet on a certificate with plenty of life left", () => {
    const { conditions } = evaluateConditions(input({ cert: cert(60) }), [], {});
    expect(conditions).toEqual([]);
  });

  it("warns inside the expiry threshold", () => {
    const { conditions } = evaluateConditions(
      input({ cert: cert(CERT_EXPIRY_THRESHOLD_DAYS) }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({
      kind: "cert-expiring",
      severity: "warning",
      detail: `app.example.com certificate expires in ${CERT_EXPIRY_THRESHOLD_DAYS} days`,
    });
  });

  it("escalates to critical inside the critical window", () => {
    const { conditions } = evaluateConditions(
      input({ cert: cert(CERT_EXPIRY_CRITICAL_DAYS) }),
      [],
      {},
    );
    expect(conditions[0]).toMatchObject({ kind: "cert-expiring", severity: "critical" });
  });

  it("says within a day rather than in 0 days", () => {
    const { conditions } = evaluateConditions(input({ cert: cert(0.5) }), [], {});
    expect(conditions[0].detail).toBe("app.example.com certificate expires within a day");
  });

  it("reports an expired certificate as critical", () => {
    const { conditions } = evaluateConditions(input({ cert: cert(-3) }), [], {});
    expect(conditions[0]).toMatchObject({
      kind: "cert-expired",
      severity: "critical",
      detail: "app.example.com certificate expired 3 days ago",
    });
  });

  it("does not report expiring and expired at once", () => {
    const { conditions } = evaluateConditions(input({ cert: cert(-1) }), [], {});
    expect(conditions.map((c) => c.kind)).toEqual(["cert-expired"]);
  });

  it("clears once a renewed certificate is observed", () => {
    const expiring = evaluateConditions(input({ cert: cert(1) }), [], {});
    const renewed = evaluateConditions(
      input({ cert: cert(90) }),
      expiring.conditions,
      expiring.streaks,
    );
    expect(renewed.conditions).toEqual([]);
  });
});

describe("unknown certificate expiry", () => {
  it("reports nothing when no domain has ever been checked", () => {
    expect(evaluateConditions(input({ cert: null }), [], {}).conditions).toEqual([]);
  });

  it("reports nothing when the observation is stale", () => {
    const stale = cert(-5, NOW - CERT_OBSERVATION_STALE_MS - 1);
    expect(evaluateConditions(input({ cert: stale }), [], {}).conditions).toEqual([]);
  });

  it("still reports an observation right at the staleness edge", () => {
    const edge = cert(-5, NOW - CERT_OBSERVATION_STALE_MS);
    expect(evaluateConditions(input({ cert: edge }), [], {}).conditions).toHaveLength(1);
  });

  it("drops the condition when checks stop and the reading goes stale", () => {
    const on = evaluateConditions(input({ cert: cert(1) }), [], {});
    const later = evaluateConditions(
      { ...input({ cert: cert(1) }), now: NOW + CERT_OBSERVATION_STALE_MS + 1 },
      on.conditions,
      on.streaks,
    );
    expect(later.conditions).toEqual([]);
  });
});

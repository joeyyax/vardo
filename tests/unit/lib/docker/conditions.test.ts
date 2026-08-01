import { describe, it, expect } from "vitest";
import {
  evaluateConditions,
  worstCondition,
  conditionsEqual,
  HYSTERESIS,
  MEMORY_PRESSURE_RATIO,
  type AppCondition,
  type ConditionInput,
  type ConditionStreaks,
} from "@/lib/docker/conditions";

const NOW = Date.parse("2026-07-31T12:00:00.000Z");

function input(overrides: Partial<ConditionInput> = {}): ConditionInput {
  return {
    now: NOW,
    crashLoop: null,
    health: null,
    selfHealExhausted: false,
    memory: null,
    ...overrides,
  };
}

/** Run the evaluator n times over the same input, threading state through. */
function settle(i: ConditionInput, n: number, prev: AppCondition[] = [], streaks: ConditionStreaks = {}) {
  let out = { conditions: prev, streaks };
  for (let k = 0; k < n; k++) out = evaluateConditions(i, out.conditions, out.streaks);
  return out;
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

describe("memory pressure hysteresis", () => {
  const over = input({ memory: { usage: 95, limit: 100 } });
  const under = input({ memory: { usage: 10, limit: 100 } });
  const gate = HYSTERESIS["memory-pressure"]!;

  it("does not fire on a single sample over the threshold", () => {
    expect(evaluateConditions(over, [], {}).conditions).toEqual([]);
  });

  it("fires once the enter streak is met", () => {
    const { conditions } = settle(over, gate.enter);
    expect(conditions.map((c) => c.kind)).toEqual(["memory-pressure"]);
    expect(conditions[0].detail).toBe("95% of memory limit");
  });

  it("holds through a dip shorter than the clear streak", () => {
    const on = settle(over, gate.enter);
    const dipping = settle(under, gate.clear - 1, on.conditions, on.streaks);
    expect(dipping.conditions.map((c) => c.kind)).toEqual(["memory-pressure"]);
  });

  it("clears once the dip reaches the clear streak", () => {
    const on = settle(over, gate.enter);
    const cleared = settle(under, gate.clear, on.conditions, on.streaks);
    expect(cleared.conditions).toEqual([]);
  });

  it("ignores an unlimited container, where a ratio is meaningless", () => {
    const unlimited = input({ memory: { usage: 8e9, limit: 0 } });
    expect(settle(unlimited, gate.enter + 2).conditions).toEqual([]);
  });

  it("fires exactly at the threshold", () => {
    const atLimit = input({ memory: { usage: MEMORY_PRESSURE_RATIO * 100, limit: 100 } });
    expect(settle(atLimit, gate.enter).conditions).toHaveLength(1);
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
  it("reports crash-looping and memory pressure together, critical first", () => {
    const both = input({
      crashLoop: { restarts: 5, windowMs: 300_000 },
      memory: { usage: 99, limit: 100 },
    });
    const { conditions } = settle(both, HYSTERESIS["memory-pressure"]!.enter);
    expect(conditions.map((c) => c.kind)).toEqual(["crash-looping", "memory-pressure"]);
  });

  it("worstCondition picks the highest severity", () => {
    const both = input({
      crashLoop: { restarts: 5, windowMs: 300_000 },
      memory: { usage: 99, limit: 100 },
    });
    const { conditions } = settle(both, HYSTERESIS["memory-pressure"]!.enter);
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

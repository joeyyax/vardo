import { describe, expect, it } from "vitest";
import {
  describeGroup,
  dueGroups,
  evaluate,
  impairedVantages,
  markImpaired,
  newMemory,
  stepDamping,
  tally,
  type CheckResult,
  type DampAction,
  type DampMemory,
  type Notice,
  type Observation,
  type VantagePoint,
} from "@/lib/uptime/core";

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const down: Observation = { state: "down", key: "down" };
const up: Observation = { state: "up", key: "up" };
const warn: Observation = { state: "degraded", key: "degraded|outside" };

/** Feeds observations in at `minute` offsets and returns every action with when it came. */
function play(steps: [number, Observation | null][], start: DampMemory = newMemory()) {
  let memory = start;
  const out: [number, DampAction][] = [];
  for (const [minute, obs] of steps) {
    const r = stepDamping(memory, obs, T0 + minute * MIN);
    memory = r.memory;
    for (const a of r.actions) out.push([minute, a]);
  }
  return { memory, actions: out };
}
/** One evaluation a minute from `from` to `to`, inclusive. */
const hold = (obs: Observation | null, from: number, to: number): [number, Observation | null][] =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, obs]);

describe("damping", () => {
  it("announces down only after it has held 3 minutes and 3 evaluations", () => {
    const { actions } = play([...hold(up, 0, 5), ...hold(down, 6, 12)]);
    expect(actions.filter(([, a]) => a.kind === "open")).toEqual([[9, { kind: "open", state: "down", key: "down", notify: true }]]);
  });

  it("waits for the longer of the two", () => {
    // Four evaluations in 3 minutes: time is met on the fourth.
    const quick = play([[0, up], ...hold(down, 1, 1), [1.5, down], [2, down], [3, down]].map(([m, o]) => [m, o] as [number, Observation]));
    expect(quick.actions.some(([, a]) => a.kind === "open")).toBe(false);
    // Three evaluations spread past 3 minutes: evaluations are met on the third.
    const slow = play([[0, down], [2, down], [3.5, down]]);
    expect(slow.actions.map(([m]) => m)).toEqual([3.5]);
  });

  it("doesn't announce a blip", () => {
    const { actions } = play([...hold(up, 0, 5), ...hold(down, 6, 7), ...hold(up, 8, 20)]);
    expect(actions.filter(([, a]) => a.kind === "open")).toEqual([]);
  });

  it("announces recovery only after up has held 3 minutes", () => {
    const { actions } = play([...hold(down, 0, 6), ...hold(up, 7, 12)]);
    expect(actions.filter(([, a]) => a.kind === "resolve")).toEqual([[10, { kind: "resolve", notify: true }]]);
  });

  it("opens degraded without notifying by default, and resolves it quietly", () => {
    const { actions } = play([...hold(warn, 0, 5), ...hold(up, 6, 10)]);
    expect(actions).toEqual([
      [3, { kind: "open", state: "degraded", key: "degraded|outside", notify: false }],
      [9, { kind: "resolve", notify: false }],
    ]);
  });

  it("can notify warnings when asked", () => {
    const m = play(hold(warn, 0, 2)).memory;
    const r = stepDamping(m, warn, T0 + 3 * MIN, { notifyWarnings: true });
    expect(r.actions).toEqual([{ kind: "open", state: "degraded", key: "degraded|outside", notify: true }]);
  });

  it("escalates degraded to down with a notice and recovers with one", () => {
    const { actions } = play([...hold(warn, 0, 4), ...hold(down, 5, 9), ...hold(up, 10, 14)]);
    expect(actions.map(([, a]) => (a.kind === "open" ? `open ${a.state} ${a.notify}` : `${a.kind} ${"notify" in a ? a.notify : ""}`))).toEqual([
      "open degraded false",
      "open down true",
      "resolve true",
    ]);
  });

  it("answers an unknown reading with nothing", () => {
    expect(stepDamping(newMemory(), null, T0).actions).toEqual([]);
    const { actions } = play([...hold(down, 0, 3), ...hold(null, 4, 20)]);
    expect(actions).toHaveLength(1);
  });

  it("resolves a leftover incident once on the first stable up, and only notifies if one was open", () => {
    const { actions } = play(hold(up, 0, 5));
    expect(actions).toEqual([[3, { kind: "resolve", notify: false, stale: true }]]);
  });

  describe("flapping", () => {
    // Down for 4 minutes, up for 4, repeated: each leg holds long enough to notify.
    const flap = (cycles: number): [number, Observation][] =>
      Array.from({ length: cycles }, (_, i) => [...hold(down, i * 8, i * 8 + 3), ...hold(up, i * 8 + 4, i * 8 + 7)]).flat() as [number, Observation][];

    it("sends one flapping notice after more than 3 changes in 30 minutes, then goes quiet", () => {
      const { actions } = play([...flap(3), ...hold(down, 24, 28)]);
      const kinds = actions.map(([, a]) => a.kind);
      expect(kinds.filter((k) => k === "flapping")).toHaveLength(1);
      const at = actions.findIndex(([, a]) => a.kind === "flapping");
      for (const [, a] of actions.slice(at + 1)) {
        if (a.kind === "open" || a.kind === "resolve") expect(a.notify).toBe(false);
      }
    });

    it("sends one notice with the settled state after 15 stable minutes", () => {
      const { actions, memory } = play([...flap(3), ...hold(down, 24, 45)]);
      const settled = actions.filter(([, a]) => a.kind === "settled");
      expect(settled).toHaveLength(1);
      expect(settled[0][1]).toEqual({ kind: "settled", state: "down" });
      expect(settled[0][0]).toBeGreaterThanOrEqual(24 + 15);
      expect(memory.flapping).toBe(false);
      // Nothing else notifies at the settle.
      expect(actions.filter(([m, a]) => m === settled[0][0] && "notify" in a && a.notify)).toEqual([]);
    });

    it("resumes normal notices after settling", () => {
      const { actions } = play([...flap(3), ...hold(down, 24, 45), ...hold(up, 46, 52)]);
      const last = actions[actions.length - 1];
      expect(last[1]).toEqual({ kind: "resolve", notify: true });
    });

    it("doesn't call three changes flapping, and blips that never hold don't count", () => {
      const { actions } = play([...flap(1), ...hold(down, 8, 12)]);
      expect(actions.some(([, a]) => a.kind === "flapping")).toBe(false);
      const blips = Array.from({ length: 10 }, (_, i) => [...hold(down, i * 4, i * 4 + 1), ...hold(up, i * 4 + 2, i * 4 + 3)]).flat();
      expect(play(blips).actions).toEqual([]);
      expect(actions.some(([, a]) => a.kind === "flapping")).toBe(false);
    });
  });
});

describe("grouping", () => {
  const notice = (name: string, at: number, extra: Partial<Notice> = {}): Notice => ({
    at,
    kind: "down",
    audience: "org1",
    monitorId: `mon_${name}`,
    name,
    title: `${name} is down`,
    detail: `${name} isn't responding.`,
    ...extra,
  });

  it("holds a group until its oldest notice has waited a minute", () => {
    const pending = [notice("a.example.com", T0), notice("b.example.com", T0 + 30_000)];
    expect(dueGroups(pending, T0 + 59_000)).toEqual({ due: [], rest: pending });
    const { due, rest } = dueGroups(pending, T0 + 60_000);
    expect(due).toEqual([pending]);
    expect(rest).toEqual([]);
  });

  it("groups by audience and kind", () => {
    const pending = [
      notice("a", T0),
      notice("b", T0, { audience: "org2" }),
      notice("c", T0, { kind: "recovered" }),
      notice("d", T0 + 50_000),
    ];
    const { due } = dueGroups(pending, T0 + 60_000);
    expect(due.map((g) => g.map((n) => n.name))).toEqual([["a", "d"], ["b"], ["c"]]);
  });

  it("reads a single notice as itself and several as one with the list", () => {
    expect(describeGroup("jy0", [notice("pouch.email", T0)])).toEqual({
      subject: "pouch.email is down",
      title: "pouch.email is down",
      message: "pouch.email isn't responding.",
    });
    const many = Array.from({ length: 12 }, (_, i) => notice(`m${String(i).padStart(2, "0")}.example.com`, T0));
    const g = describeGroup("jy0", many);
    expect(g.subject).toBe("jy0: 12 monitors down");
    expect(g.message.split("\n")).toHaveLength(12);
    expect(g.message).toContain("- m00.example.com");
    expect(g.message).not.toContain("mon_");
  });
});

describe("impaired vantage points", () => {
  const LOCAL: VantagePoint = { id: "local", name: "This instance", kind: "local" };
  const LH: VantagePoint = { id: "ext_lh", name: "Long House", kind: "external" };
  const NOW = T0;
  const result = (vantageId: string, monitorId: string, ageSec: number, ok: boolean, error?: CheckResult["error"]): CheckResult => ({
    monitorId,
    vantageId,
    path: vantageId === "local" ? "local" : "public",
    at: NOW - ageSec * 1000,
    ok,
    latencyMs: 7000,
    ...(error ? { error } : {}),
  });

  it("marks a vantage point whose checks mostly time out", () => {
    const timeouts = Array.from({ length: 12 }, (_, i) => result("ext_lh", `m${i}`, i * 10, false, "timeout"));
    const fine = Array.from({ length: 5 }, (_, i) => result("ext_lh", `n${i}`, i * 10, true));
    expect([...impairedVantages(tally([...timeouts, ...fine], NOW))]).toEqual(["ext_lh"]);
    expect([...impairedVantages(tally([...timeouts.slice(0, 4), ...fine, ...fine], NOW))]).toEqual([]);
  });

  it("needs enough checks to judge, and ignores old ones", () => {
    const few = Array.from({ length: 6 }, (_, i) => result("ext_lh", `m${i}`, i, false, "timeout"));
    expect(impairedVantages(tally(few, NOW)).size).toBe(0);
    const old = Array.from({ length: 20 }, (_, i) => result("ext_lh", `m${i}`, 3600 + i, false, "timeout"));
    expect(impairedVantages(tally(old, NOW)).size).toBe(0);
  });

  it("counts an impaired vantage point's timeouts as no data, not the target failing", () => {
    const failing = [result("ext_lh", "m", 60, false, "timeout"), result("ext_lh", "m", 0, false, "timeout")];
    const localOk = [result("local", "m", 60, true), result("local", "m", 0, true)];
    const plain = evaluate({ vantages: [LOCAL, LH], results: [...failing, ...localOk], now: NOW, intervalSec: 60 });
    expect(plain.state).toBe("degraded");
    const impaired = evaluate({ vantages: [LOCAL, LH], results: [...failing, ...localOk], now: NOW, intervalSec: 60, impaired: new Set(["ext_lh"]) });
    expect(impaired).toMatchObject({ state: "up", localOnly: true });
    expect(impaired.reading).toBeUndefined();
  });

  it("still trusts its other results, and other vantage points' timeouts", () => {
    const refused = [{ ...result("ext_lh", "m", 60, false, "refused") }, { ...result("ext_lh", "m", 0, false, "refused") }];
    const kept = markImpaired(refused, new Set(["ext_lh"]));
    expect(kept.every((r) => r.error === "refused")).toBe(true);
    const other = [result("ext_x", "m", 0, false, "timeout")];
    expect(markImpaired(other, new Set(["ext_lh"]))[0].error).toBe("timeout");
  });
});

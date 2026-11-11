import { describe, expect, it } from "vitest";
import {
  LOST_CONTACT_POLLS,
  REFIRE_MS,
  advance,
  readingFromVars,
  testOutcome,
  upsHealth,
  type PollResult,
  type UpsState,
} from "@/lib/ups/status";

const T0 = new Date("2026-11-11T12:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

const ok = (status: string, extra: Record<string, string> = {}): PollResult => ({
  ok: true,
  reading: readingFromVars({ "ups.status": status, "battery.charge": "90", "ups.test.result": "done and passed", ...extra }),
});
const fail: PollResult = { ok: false, error: "ECONNREFUSED" };

/** Runs polls in order, 15s apart, and returns every transition with the final state. */
function run(polls: PollResult[], start: UpsState | null = null, graceSec = 0) {
  let state = start;
  const seen: string[] = [];
  polls.forEach((poll, i) => {
    const next = advance(state, poll, at(i * 15), { graceSec });
    state = next.state;
    for (const t of next.transitions) seen.push(`${t.kind}:${t.condition}`);
  });
  return { state: state!, seen };
}

describe("readingFromVars", () => {
  it("reads the real server's values", () => {
    const r = readingFromVars({
      "battery.charge": "90",
      "battery.runtime": "1460",
      "ups.load": "24",
      "ups.realpower": "240.0",
      "input.voltage": "121.3",
      "ups.status": "OL CHRG",
      "ups.model": "2U_1440VA_120V",
      "ups.mfr": "Ubiquiti",
      "ups.test.result": "done and passed",
    });
    expect(r).toMatchObject({ flags: ["OL", "CHRG"], charge: 90, runtime: 1460, load: 24, realpower: 240, inputVoltage: 121.3, model: "2U_1440VA_120V", mfr: "Ubiquiti" });
  });

  it("leaves missing and unparseable numbers null", () => {
    const r = readingFromVars({ "ups.status": "OL", "battery.charge": "n/a" });
    expect(r.charge).toBeNull();
    expect(r.runtime).toBeNull();
  });
});

describe("testOutcome", () => {
  it("classifies NUT's result strings", () => {
    expect(testOutcome("Done and passed")).toBe("passed");
    expect(testOutcome("Done and error")).toBe("failed");
    expect(testOutcome("Done and warning")).toBe("failed");
    expect(testOutcome("No test initiated")).toBe("neutral");
    expect(testOutcome("In progress")).toBe("neutral");
    expect(testOutcome(null)).toBe("neutral");
  });
});

describe("advance: power", () => {
  it("fires on battery once while OB holds, then clears on OL", () => {
    const { seen, state } = run([ok("OL CHRG"), ok("OB DISCHRG"), ok("OB DISCHRG"), ok("OL CHRG")]);
    expect(seen).toEqual(["fired:on-battery", "cleared:on-battery"]);
    expect(state.onBatterySince).toBeNull();
  });

  it("keeps when the outage started across polls", () => {
    const { state } = run([ok("OB"), ok("OB"), ok("OB")]);
    expect(state.onBatterySince).toBe(at(0).toISOString());
  });

  it("stays quiet when online from the start", () => {
    expect(run([ok("OL"), ok("OL CHRG"), ok("OL")]).seen).toEqual([]);
  });

  it("doesn't call power restored when the status has neither OB nor OL", () => {
    expect(run([ok("OB"), ok("OFF")]).seen).toEqual(["fired:on-battery"]);
  });

  it("fires low battery and replace battery on their flags and clears them", () => {
    const { seen } = run([ok("OB"), ok("OB LB"), ok("OL CHRG RB"), ok("OL")]);
    expect(seen).toEqual(["fired:on-battery", "fired:low-battery", "cleared:on-battery", "cleared:low-battery", "fired:replace-battery", "cleared:replace-battery"]);
  });

  it("fires a failed self-test, ignores in-progress, clears on a pass", () => {
    const { seen } = run([
      ok("OL", { "ups.test.result": "Done and error" }),
      ok("OL", { "ups.test.result": "In progress" }),
      ok("OL", { "ups.test.result": "Done and passed" }),
    ]);
    expect(seen).toEqual(["fired:test-failed", "cleared:test-failed"]);
  });

  it("fires again once the re-fire window passes while still on battery", () => {
    const first = advance(null, ok("OB"), T0, { graceSec: 0 });
    const soon = advance(first.state, ok("OB"), new Date(T0.getTime() + REFIRE_MS["on-battery"] - 1), { graceSec: 0 });
    const later = advance(soon.state, ok("OB"), new Date(T0.getTime() + REFIRE_MS["on-battery"]), { graceSec: 0 });
    expect(soon.transitions).toEqual([]);
    expect(later.transitions).toEqual([{ kind: "fired", condition: "on-battery", repeat: true }]);
  });
});

describe("advance: on-battery grace period", () => {
  it("sends nothing for a blip back to mains inside the grace period, and records it", () => {
    // OB at 15s and 30s, OL at 45s: 30s on battery against a 31s grace.
    const { seen, state } = run([ok("OL"), ok("OB DISCHRG"), ok("OB DISCHRG"), ok("OL CHRG")], null, 31);
    expect(seen).toEqual([]);
    expect(state.lastBlip).toEqual({ at: at(15).toISOString(), durationMs: 30_000 });
    expect(state.onBatterySince).toBeNull();
  });

  it("fires once when the outage outlasts the grace period, and clears on mains without a blip", () => {
    const outage = Array.from({ length: 8 }, () => ok("OB DISCHRG"));
    const { seen, state } = run([ok("OL"), ...outage, ok("OL")], null, 30);
    expect(seen).toEqual(["fired:on-battery", "cleared:on-battery"]);
    expect(state.lastBlip ?? null).toBeNull();
  });

  it("fires on the first poll at or past the grace period", () => {
    const polls = [ok("OL"), ok("OB"), ok("OB"), ok("OB")];
    const fireAt = (grace: number) => {
      let state: UpsState | null = null;
      for (const [i, poll] of polls.entries()) {
        const next = advance(state, poll, at(i * 15), { graceSec: grace });
        state = next.state;
        if (next.transitions.some((t) => t.kind === "fired" && t.condition === "on-battery")) return i * 15;
      }
      return null;
    };
    expect(fireAt(30)).toBe(45);
    expect(fireAt(31)).toBeNull();
  });

  it("fires low battery at once inside the grace period", () => {
    const { seen } = run([ok("OL"), ok("OB LB")], null, 300);
    expect(seen).toEqual(["fired:low-battery"]);
  });

  it("fires on the first on-battery poll with a grace of 0", () => {
    const first = advance(null, ok("OB"), T0, { graceSec: 0 });
    expect(first.transitions).toEqual([{ kind: "fired", condition: "on-battery", repeat: false }]);
  });

  it("defaults to a 30s grace", () => {
    expect(advance(null, ok("OB"), T0).transitions).toEqual([]);
  });

  it("keeps the grace clock through failed polls", () => {
    const { seen } = run([ok("OB"), fail, ok("OB")], null, 30);
    expect(seen).toEqual(["fired:on-battery"]);
  });
});

describe("advance: contact", () => {
  it(`loses contact on the ${LOST_CONTACT_POLLS}th failed poll in a row, not before`, () => {
    const fails = Array.from({ length: LOST_CONTACT_POLLS - 1 }, () => fail);
    expect(run([ok("OL"), ...fails]).seen).toEqual([]);
    expect(run([ok("OL"), ...fails, fail]).seen).toEqual(["fired:contact-lost"]);
  });

  it("a success in between resets the count", () => {
    const almost = Array.from({ length: LOST_CONTACT_POLLS - 1 }, () => fail);
    const { seen, state } = run([ok("OL"), ...almost, ok("OL"), ...almost]);
    expect(seen).toEqual([]);
    expect(state.failedPolls).toBe(LOST_CONTACT_POLLS - 1);
  });

  it("fires once while lost and clears on the next good poll", () => {
    const fails = Array.from({ length: LOST_CONTACT_POLLS + 3 }, () => fail);
    expect(run([ok("OL"), ...fails, ok("OL")]).seen).toEqual(["fired:contact-lost", "cleared:contact-lost"]);
  });

  it("keeps the last reading and on-battery alert through failed polls", () => {
    const fails = Array.from({ length: LOST_CONTACT_POLLS }, () => fail);
    const { seen, state } = run([ok("OB"), ...fails]);
    expect(seen).toEqual(["fired:on-battery", "fired:contact-lost"]);
    expect(state.reading?.flags).toEqual(["OB"]);
    expect(state.fired["on-battery"]).toBeDefined();
    expect(state.lastError).toBe("ECONNREFUSED");
  });

  it("counts from persisted state, so a restart mid-outage doesn't fire twice", () => {
    const fails = Array.from({ length: LOST_CONTACT_POLLS }, () => fail);
    const before = run([ok("OL"), ...fails]);
    const persisted = JSON.parse(JSON.stringify(before.state)) as UpsState;
    expect(run([fail, fail], persisted).seen).toEqual([]);
  });
});

describe("upsHealth", () => {
  it("reads the headline state", () => {
    expect(upsHealth(null)).toBe("unknown");
    expect(upsHealth(run([ok("OL CHRG")]).state)).toBe("online");
    expect(upsHealth(run([ok("OB DISCHRG")]).state)).toBe("on-battery");
    expect(upsHealth(run([ok("OB LB")]).state)).toBe("low-battery");
    expect(upsHealth(run([fail]).state)).toBe("unknown");
    expect(upsHealth(run(Array.from({ length: LOST_CONTACT_POLLS }, () => fail)).state)).toBe("lost-contact");
  });
});

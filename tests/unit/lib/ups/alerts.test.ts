import { describe, expect, it } from "vitest";
import { noticeFor } from "@/lib/ups/alerts";
import { LOST_CONTACT_POLLS, advance, readingFromVars, type PollResult, type UpsState } from "@/lib/ups/status";

const ups = { id: "u1", name: "Rack UPS", host: "10.0.0.155", port: 3493 };
const T0 = new Date("2026-11-11T12:00:00Z");

const ok = (status: string, extra: Record<string, string> = {}): PollResult => ({
  ok: true,
  reading: readingFromVars({ "ups.status": status, "battery.charge": "80", "battery.runtime": "1200", "ups.load": "24", ...extra }),
});

/** The notices a sequence of polls sends, one poll per 15s. */
function notices(polls: PollResult[]) {
  let state: UpsState | null = null;
  const out = [];
  for (const [i, poll] of polls.entries()) {
    const now = new Date(T0.getTime() + i * 15_000);
    const next = advance(state, poll, now, { graceSec: 0 });
    state = next.state;
    for (const t of next.transitions) out.push(noticeFor(ups, t, next.state, now));
  }
  return out;
}

describe("noticeFor", () => {
  it("opens a critical incident on battery and resolves it when power returns", () => {
    const [open, resolve] = notices([ok("OL"), ok("OB DISCHRG"), ...Array.from({ length: 3 }, () => ok("OB")), ok("OL CHRG")]);
    expect(open).toMatchObject({
      action: "open",
      problem: { kind: "ups.on-battery", about: "u1", severity: "critical" },
      event: { type: "system.power", change: "on-battery", charge: 80, runtimeSec: 1200, load: 24 },
    });
    expect(resolve).toMatchObject({ action: "resolve", kind: "ups.on-battery", about: "u1" });
    expect(resolve && "detail" in resolve && resolve.detail).toContain("after 1 min");
  });

  it("opens a lost-contact incident and resolves it on contact", () => {
    const fail: PollResult = { ok: false, error: "ETIMEDOUT" };
    const [open, resolve] = notices([ok("OL"), ...Array.from({ length: LOST_CONTACT_POLLS }, () => fail), ok("OL")]);
    expect(open).toMatchObject({ action: "open", problem: { kind: "ups.contact-lost", severity: "warning" }, event: { change: "contact-lost" } });
    expect(open && "event" in open && open.event.message).toContain("ETIMEDOUT");
    expect(resolve).toMatchObject({ action: "resolve", kind: "ups.contact-lost" });
  });

  it("sends low battery, replace battery and failed self-test as plain alerts and stays quiet when they clear", () => {
    const sent = notices([ok("OB LB RB", { "ups.test.result": "Done and error" }), ok("OL", { "ups.test.result": "Done and passed" })]);
    const changes = sent.filter((n) => n?.action === "send").map((n) => n && "event" in n && n.event.change);
    expect(changes.sort()).toEqual(["low-battery", "replace-battery", "test-failed"]);
    expect(sent.filter((n) => n === null)).toHaveLength(3);
    const test = sent.find((n) => n && "event" in n && n.event.change === "test-failed");
    expect(test && "event" in test && test.event.testResult).toBe("Done and error");
  });
});

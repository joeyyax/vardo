import { describe, expect, it } from "vitest";
import { banRef, displayRef, isBanRef, matchesRef, parseRef } from "@/lib/probe-guard/ban-ref";

const DAY = new Date("2026-10-13T12:00:00Z");

describe("banRef", () => {
  it("is the UTC day and four unambiguous characters", () => {
    const ref = banRef("n4Zq8e1Wj0K-b3xT_9mPd", DAY);
    expect(ref).toMatch(/^13-[2-9A-HJ-NP-Z]{4}$/);
    expect(isBanRef(ref)).toBe(true);
    expect(displayRef(403, ref)).toBe(`403-${ref}`);
  });

  it("is the same for the same ban and takes its day in UTC", () => {
    expect(banRef("ban-a", DAY)).toBe(banRef("ban-a", DAY));
    expect(banRef("ban-a", "2026-10-13T23:59:59Z").slice(0, 2)).toBe("13");
    expect(banRef("ban-a", "2026-10-14T00:00:00Z").slice(0, 2)).toBe("14");
    expect(banRef("ban-a", "2026-10-05T10:00:00Z").slice(0, 2)).toBe("05");
  });

  it("spreads bans made the same day across the code space", () => {
    const codes = new Set(Array.from({ length: 2000 }, (_, i) => banRef(`ban-${i}-${i * 7919}`, DAY)));
    expect(codes.size).toBeGreaterThan(1980);
  });

  it("never uses 0, 1, I or O in the code", () => {
    for (let i = 0; i < 500; i++) expect(banRef(`ban-${i}`, DAY).slice(3)).not.toMatch(/[01IO]/);
  });

  it("recognizes only its own shape", () => {
    expect(isBanRef("13-K7M2")).toBe(true);
    for (const bad of ["K7M2", "13-K7M", "13-K7M22", "13-k7m2", "13-K0M2", "1-K7M2", "403-13-K7M2"]) expect(isBanRef(bad), bad).toBe(false);
  });
});

describe("parseRef", () => {
  it.each([
    ["403-13-K7M2", { day: "13", code: "K7M2" }],
    ["13-k7m2", { day: "13", code: "K7M2" }],
    ["13 K7 M2", { day: "13", code: "K7M2" }],
    ["13K7M2", { day: "13", code: "K7M2" }],
    ["40313K7M2", { day: "13", code: "K7M2" }],
    ["K7M2", { code: "K7M2" }],
    ["  k7 ", { code: "K7" }],
    ["403", { code: "" }],
    ["", { code: "" }],
  ])("reads %j", (input, expected) => {
    expect(parseRef(input)).toEqual(expected);
  });
});

describe("matchesRef", () => {
  const id = "ban-abc";
  const [day, code] = banRef(id, DAY).split("-");

  it("matches the full reference however it's typed", () => {
    for (const typed of [`403-${day}-${code}`, `${day}-${code}`, code, code.toLowerCase(), `${day} ${code}`, `${day}${code}`]) {
      expect(matchesRef(id, DAY, typed), typed).toBe(true);
    }
  });

  it("matches a partial code from its start", () => {
    expect(matchesRef(id, DAY, code.slice(0, 2))).toBe(true);
    expect(matchesRef(id, DAY, `${day}-${code.slice(0, 1)}`)).toBe(true);
    expect(matchesRef(id, DAY, code.slice(1))).toBe(false);
  });

  it("rejects a different day, which is what narrows a search", () => {
    expect(matchesRef(id, DAY, `14-${code}`)).toBe(false);
    expect(matchesRef(id, "2026-10-14T00:00:00Z", `${day}-${code}`)).toBe(false);
  });

  it("matches everything from that day for a bare day, and everything for an empty search", () => {
    expect(matchesRef(id, DAY, "13")).toBe(true);
    expect(matchesRef(id, DAY, "")).toBe(true);
    expect(matchesRef(id, DAY, "403")).toBe(true);
  });
});

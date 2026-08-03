// ---------------------------------------------------------------------------
// Which slot is safe to stop. Both slot dirs share one git dir, so their shas
// are identical — the `current` symlink is the only thing that answers this.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";

import { decideStandbySweep, otherSlot } from "@/lib/docker/standby-slot";

const bothUp = { blue: true, green: true };

describe("decideStandbySweep", () => {
  it("stops the slot the symlink does not name", () => {
    expect(decideStandbySweep({ currentSlot: "green", running: bothUp })).toEqual({
      act: true,
      standby: "blue",
    });
    expect(decideStandbySweep({ currentSlot: "blue", running: bothUp })).toEqual({
      act: true,
      standby: "green",
    });
  });

  it("refuses when there is no symlink to identify the live slot", () => {
    const verdict = decideStandbySweep({ currentSlot: null, running: bothUp });
    expect(verdict.act).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("symlink") });
  });

  it("refuses when the symlink names a slot that is not running", () => {
    // Docker and the symlink disagree, so the running slot may be the one
    // serving. Stopping it on the symlink's word would take the app down.
    const verdict = decideStandbySweep({
      currentSlot: "green",
      running: { blue: true, green: false },
    });
    expect(verdict.act).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("not running") });
  });

  it("refuses when Docker could not be read", () => {
    const verdict = decideStandbySweep({ currentSlot: "green", running: null });
    expect(verdict.act).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining("Docker") });
  });

  it("does nothing, without refusing, when only the live slot is up", () => {
    expect(
      decideStandbySweep({ currentSlot: "green", running: { blue: false, green: true } }),
    ).toEqual({ act: false, refused: false, reason: "no standby is running" });
  });

  it("refuses when neither slot is running", () => {
    const verdict = decideStandbySweep({
      currentSlot: "blue",
      running: { blue: false, green: false },
    });
    expect(verdict).toMatchObject({ act: false, refused: true });
  });

  it("pairs the slots", () => {
    expect(otherSlot("blue")).toBe("green");
    expect(otherSlot("green")).toBe("blue");
  });
});

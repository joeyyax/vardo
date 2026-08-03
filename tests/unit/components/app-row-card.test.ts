import { describe, it, expect } from "vitest";

import { memoryLimitLabel, restartLine } from "@/components/app-row-card";
import { restartNote, rowNote } from "@/lib/ui/app-row";

describe("memoryLimitLabel", () => {
  it("reads null as unknown -- never observed", () => {
    expect(memoryLimitLabel(null)).toBe("Unknown");
  });

  it("reads 0 as genuinely uncapped, not unknown", () => {
    expect(memoryLimitLabel(0)).toBe("No limit");
  });

  it("null and 0 must not produce the same label", () => {
    expect(memoryLimitLabel(null)).not.toBe(memoryLimitLabel(0));
  });

  it("formats a positive limit", () => {
    expect(memoryLimitLabel(512 * 1024 * 1024)).toBe("512 MB limit");
  });
});

describe("restartLine", () => {
  it("carries the count with the qualifier that stops it reading as history", () => {
    expect(restartLine(12)).toMatchObject({
      label: "12 restarts",
      tone: "text-status-warning",
      qualifier: "resets on deploy",
    });
  });

  it("says nothing for an ordinary count", () => {
    expect(restartLine(1)).toBeNull();
  });

  it("tells an unread count apart from zero", () => {
    expect(restartLine(0)).toBeNull();
    expect(restartLine(null)).toBeNull();
    expect(restartLine(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Row and card agreement
//
// A row reading "12 restarts" must not open a card that words it differently or
// omits it. Mirrors the note AppRow composes in components/app-row.tsx.
// ---------------------------------------------------------------------------

describe("the row's cue and the card's line", () => {
  const rowCue = (count: number | null) => rowNote(null, false, restartNote(count));

  it.each([null, 0, 1, 2, 3, 12, 400])("say the same thing at %s", (count) => {
    expect(restartLine(count)?.label ?? null).toBe(rowCue(count)?.label ?? null);
    expect(restartLine(count)?.tone ?? null).toBe(rowCue(count)?.tone ?? null);
  });
});

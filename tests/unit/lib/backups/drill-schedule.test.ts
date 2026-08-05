import { describe, it, expect } from "vitest";
import {
  selectDrillCandidates,
  drillPriority,
  DRILL_INTERVAL_MS,
  type DrillCandidate,
} from "@/lib/backups/drill-schedule";

const NOW = new Date("2026-08-04T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 24 * 60 * 60 * 1000;

function candidate(over: Partial<DrillCandidate> & { backupId: string; volumeKey: string }): DrillCandidate {
  return {
    finishedAt: ago(DAY),
    verifiedAt: null,
    verifyOutcome: null,
    ...over,
  };
}

describe("drillPriority", () => {
  it("puts a never-drilled archive first — its verdict is unknown", () => {
    expect(drillPriority(candidate({ backupId: "a", volumeKey: "v" }), NOW)).toBe(0);
  });

  it("puts a previous failure next, so a fix is confirmed rather than assumed", () => {
    const c = candidate({ backupId: "a", volumeKey: "v", verifiedAt: ago(DAY), verifyOutcome: "failed" });
    expect(drillPriority(c, NOW)).toBe(1);
  });

  it("re-drills a verified archive once its verification has aged out", () => {
    const stale = candidate({
      backupId: "a", volumeKey: "v",
      verifiedAt: ago(DRILL_INTERVAL_MS + DAY), verifyOutcome: "verified",
    });
    expect(drillPriority(stale, NOW)).toBe(2);
  });

  it("leaves a recently verified archive alone", () => {
    const fresh = candidate({
      backupId: "a", volumeKey: "v", verifiedAt: ago(DAY), verifyOutcome: "verified",
    });
    expect(drillPriority(fresh, NOW)).toBe(3);
  });
});

describe("selectDrillCandidates", () => {
  it("schedules nothing when everything was verified this week", () => {
    const fresh = [
      candidate({ backupId: "a", volumeKey: "v1", verifiedAt: ago(DAY), verifyOutcome: "verified" }),
      candidate({ backupId: "b", volumeKey: "v2", verifiedAt: ago(2 * DAY), verifyOutcome: "verified" }),
    ];
    expect(selectDrillCandidates(fresh, NOW, 5)).toEqual([]);
  });

  it("drills one archive per volume, not one per run", () => {
    const many = [
      candidate({ backupId: "old", volumeKey: "v1", finishedAt: ago(3 * DAY) }),
      candidate({ backupId: "new", volumeKey: "v1", finishedAt: ago(DAY) }),
    ];
    const picked = selectDrillCandidates(many, NOW, 5);
    expect(picked).toHaveLength(1);
    expect(picked[0].backupId).toBe("new");
  });

  it("takes the newest archive for a volume — an old one proves less", () => {
    const picked = selectDrillCandidates(
      [
        candidate({ backupId: "yesterday", volumeKey: "v", finishedAt: ago(DAY) }),
        candidate({ backupId: "lastweek", volumeKey: "v", finishedAt: ago(7 * DAY) }),
      ],
      NOW,
      5,
    );
    expect(picked[0].backupId).toBe("yesterday");
  });

  it("prefers never-drilled over stale-verified", () => {
    const picked = selectDrillCandidates(
      [
        candidate({ backupId: "stale", volumeKey: "v1", verifiedAt: ago(DRILL_INTERVAL_MS + DAY), verifyOutcome: "verified" }),
        candidate({ backupId: "never", volumeKey: "v2" }),
      ],
      NOW,
      1,
    );
    expect(picked[0].backupId).toBe("never");
  });

  it("prefers a past failure over a stale success", () => {
    const picked = selectDrillCandidates(
      [
        candidate({ backupId: "stale", volumeKey: "v1", verifiedAt: ago(DRILL_INTERVAL_MS + DAY), verifyOutcome: "verified" }),
        candidate({ backupId: "broken", volumeKey: "v2", verifiedAt: ago(2 * DAY), verifyOutcome: "failed" }),
      ],
      NOW,
      1,
    );
    expect(picked[0].backupId).toBe("broken");
  });

  it("within a band, takes the least recently confirmed", () => {
    const picked = selectDrillCandidates(
      [
        candidate({ backupId: "recent", volumeKey: "v1", verifiedAt: ago(DRILL_INTERVAL_MS + DAY), verifyOutcome: "verified" }),
        candidate({ backupId: "ancient", volumeKey: "v2", verifiedAt: ago(90 * DAY), verifyOutcome: "verified" }),
      ],
      NOW,
      1,
    );
    expect(picked[0].backupId).toBe("ancient");
  });

  it("honors the limit, so one tick cannot start a fleet of drills", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate({ backupId: `b${i}`, volumeKey: `v${i}` }),
    );
    expect(selectDrillCandidates(many, NOW, 3)).toHaveLength(3);
  });

  it("handles an empty fleet", () => {
    expect(selectDrillCandidates([], NOW, 5)).toEqual([]);
  });
});

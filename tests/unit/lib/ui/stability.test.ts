import { describe, it, expect } from "vitest";

import type { AppCondition } from "@/lib/docker/conditions";
import type { ExitReason } from "@/lib/docker/exit-reason";
import {
  buildIncidents,
  heldFor,
  incidentLabel,
  incidentTone,
  isFault,
  restartCaption,
  stabilitySurface,
  stabilityTone,
  stabilityTrend,
  stabilityVerdict,
  trendBadge,
  trendTone,
  TREND_WINDOW_MS,
  type Incident,
} from "@/lib/ui/stability";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function at(daysAgo: number): number {
  return NOW - daysAgo * DAY;
}

function fault(daysAgo: number, kind: Incident["kind"] = "crashed"): Incident {
  return { kind, at: at(daysAgo), detail: "detail" };
}

function condition(kind: AppCondition["kind"], severity: AppCondition["severity"]): AppCondition {
  return { kind, severity, since: new Date(at(1)).toISOString(), detail: `${kind} detail` };
}

const OOM: ExitReason = {
  kind: "oom-limit",
  exitCode: 137,
  containerId: "abc",
  containerName: "app-1",
  at: new Date(at(1)).toISOString(),
};

describe("buildIncidents", () => {
  it("merges both durable sources newest first", () => {
    const incidents = buildIncidents(
      [
        { action: "app.crashed", createdAt: new Date(at(3)), metadata: { summary: "Exited with code 1" } },
        { action: "app.recovered", createdAt: new Date(at(2)), metadata: { summary: "Running again after 4m down" } },
      ],
      [
        { status: "failed", postDeployError: null, startedAt: new Date(at(5)), finishedAt: new Date(at(5)) },
        { status: "success", postDeployError: null, startedAt: new Date(at(1)), finishedAt: new Date(at(1)) },
      ],
    );

    expect(incidents.map((i) => i.kind)).toEqual(["recovered", "crashed", "deploy-failed"]);
    expect(incidents[1].detail).toBe("Exited with code 1");
  });

  it("reads a rollback and an unfinished deploy as their own kinds", () => {
    const incidents = buildIncidents(
      [],
      [
        { status: "rolled_back", postDeployError: null, startedAt: new Date(at(2)), finishedAt: new Date(at(2)) },
        {
          status: "success",
          postDeployError: "hook failed\nstack trace",
          startedAt: new Date(at(1)),
          finishedAt: new Date(at(1)),
        },
      ],
    );

    expect(incidents.map((i) => i.kind)).toEqual(["deploy-incomplete", "rolled-back"]);
    expect(incidents[0].detail).toBe("hook failed");
  });

  it("ignores rows it has no phrasing for and rows with no usable date", () => {
    const incidents = buildIncidents(
      [
        { action: "app.updated", createdAt: new Date(at(1)), metadata: null },
        { action: "app.crashed", createdAt: "not a date", metadata: null },
      ],
      [{ status: "success", postDeployError: null, startedAt: new Date(at(1)), finishedAt: null }],
    );

    expect(incidents).toEqual([]);
  });

  it("falls back to a written summary when metadata carries none", () => {
    const [incident] = buildIncidents(
      [{ action: "app.crash_looping", createdAt: new Date(at(1)), metadata: {} }],
      [],
    );
    expect(incident.detail).toBe("Restarting without ever reaching healthy");
  });

  it("dates a deploy from when it finished, falling back to its start", () => {
    const [incident] = buildIncidents(
      [],
      [{ status: "failed", postDeployError: null, startedAt: new Date(at(4)), finishedAt: null }],
    );
    expect(incident.at).toBe(at(4));
  });
});

describe("isFault", () => {
  it("counts everything but a recovery", () => {
    expect(isFault("crashed")).toBe(true);
    expect(isFault("rolled-back")).toBe(true);
    expect(isFault("recovered")).toBe(false);
  });
});

describe("stabilityTrend", () => {
  const oldEnough = new Date(NOW - 60 * DAY);

  it("will not compare against a period it has no history for", () => {
    const trend = stabilityTrend([fault(1)], NOW, new Date(NOW - 3 * DAY));
    expect(trend.direction).toBe("unknown");
    expect(trend.prior).toBeUndefined();
    expect(trend.recent).toBe(1);
  });

  it("reads quiet when neither period had anything", () => {
    expect(stabilityTrend([], NOW, oldEnough).direction).toBe("quiet");
  });

  it("reads worsening when the recent period has more", () => {
    const trend = stabilityTrend([fault(1), fault(2), fault(10)], NOW, oldEnough);
    expect(trend).toMatchObject({ direction: "worsening", recent: 2, prior: 1 });
  });

  it("reads improving when the recent period has fewer", () => {
    const trend = stabilityTrend([fault(1), fault(9), fault(10)], NOW, oldEnough);
    expect(trend).toMatchObject({ direction: "improving", recent: 1, prior: 2 });
  });

  it("reads steady when both periods match", () => {
    const trend = stabilityTrend([fault(1), fault(10)], NOW, oldEnough);
    expect(trend).toMatchObject({ direction: "steady", recent: 1, prior: 1 });
  });

  it("leaves recoveries out of the count", () => {
    const trend = stabilityTrend([fault(1), fault(1, "recovered")], NOW, oldEnough);
    expect(trend.recent).toBe(1);
  });

  it("drops incidents older than both windows", () => {
    const trend = stabilityTrend([fault(20)], NOW, oldEnough);
    expect(trend).toMatchObject({ direction: "quiet", recent: 0, prior: 0 });
  });

  it("badges nothing when the recent period was clean", () => {
    expect(trendBadge(stabilityTrend([], NOW, oldEnough))).toBeNull();
  });

  it("badges the count, and says so when it is up", () => {
    expect(trendBadge(stabilityTrend([fault(1), fault(2)], NOW, oldEnough))).toBe("2 in 7d, up");
    expect(trendBadge(stabilityTrend([fault(1), fault(9), fault(10)], NOW, oldEnough))).toBe("1 in 7d");
  });

  it("puts an incident on the window boundary in the prior period", () => {
    const boundary: Incident = { kind: "crashed", at: NOW - TREND_WINDOW_MS, detail: "" };
    const trend = stabilityTrend([boundary], NOW, oldEnough);
    expect(trend).toMatchObject({ recent: 0, prior: 1 });
  });
});

describe("stabilityVerdict", () => {
  const quiet = stabilityTrend([], NOW, new Date(NOW - 60 * DAY));

  function verdict(overrides: Partial<Parameters<typeof stabilityVerdict>[0]> = {}) {
    return stabilityVerdict({
      now: NOW,
      status: "active",
      conditions: null,
      exitReason: null,
      incidents: [],
      trend: quiet,
      ...overrides,
    });
  }

  it("calls a clean running app with no history stable", () => {
    expect(verdict()).toMatchObject({ level: "stable", headline: "Stable" });
  });

  it("separates a running app with recent incidents from a clean one", () => {
    const incidents = [fault(3), fault(5)];
    const trend = stabilityTrend(incidents, NOW, new Date(NOW - 60 * DAY));
    const result = verdict({ incidents, trend });

    expect(result.level).toBe("watch");
    expect(result.headline).toBe("Running");
    expect(result.detail).toContain("2 incidents");
  });

  it("names the fault when the app only just came back", () => {
    const incidents = [{ kind: "crashed" as const, at: NOW - 2 * 60 * 60 * 1000, detail: "x" }];
    const result = verdict({ incidents });

    expect(result).toMatchObject({ level: "watch", headline: "Running again" });
    expect(result.detail).toBe("crashed 2h ago");
  });

  it("reads a crash loop as unstable even while Docker calls it running", () => {
    const result = verdict({ conditions: [condition("crash-looping", "critical")] });
    expect(result).toMatchObject({ level: "unstable", headline: "Unstable" });
    expect(result.detail).toBe("crash-looping detail");
  });

  it("reads an exhausted self-heal as unstable", () => {
    expect(verdict({ conditions: [condition("self-heal-exhausted", "critical")] }).level).toBe("unstable");
  });

  it("names how the last container ended when the app is down", () => {
    const result = verdict({ status: "error", exitReason: OOM });
    expect(result).toMatchObject({ level: "down", headline: "Down" });
    expect(result.detail).toBe("Last container hit its memory limit");
  });

  it("says so when there is no container at all", () => {
    expect(verdict({ status: "missing" })).toMatchObject({ level: "down", headline: "No container" });
  });

  it("claims nothing about an app that is off or mid-deploy", () => {
    expect(verdict({ status: "stopped" }).level).toBe("unknown");
    expect(verdict({ status: "deploying" }).level).toBe("unknown");
  });

  it("lets a warning condition qualify a running app", () => {
    const result = verdict({ conditions: [condition("memory-pressure", "warning")] });
    expect(result).toMatchObject({ level: "watch", headline: "Degraded" });
  });

  it("dates the last incident on an app that has been clean since", () => {
    const result = verdict({ incidents: [fault(20)] });
    expect(result.level).toBe("stable");
    expect(result.detail).toBe("Last incident 20d ago");
  });
});

describe("restartCaption", () => {
  it("always names the point the count resets from", () => {
    const caption = restartCaption({ count: 12, since: new Date(at(3)).toISOString() }, NOW);
    expect(caption).toContain("created 3d ago");
    expect(caption).toContain("restarts at zero");
  });

  it("still warns about the reset when the container age is unknown", () => {
    expect(restartCaption({ count: 4, since: null }, NOW)).toContain("restarts at zero");
  });

  it("says Docker was unreachable rather than implying zero", () => {
    expect(restartCaption(null, NOW)).toBe("Docker was not reachable");
  });
});

describe("heldFor", () => {
  it("renders nothing for a row that has never transitioned", () => {
    expect(heldFor(null, NOW)).toBeNull();
  });

  it("renders the span without the ago suffix", () => {
    expect(heldFor(new Date(at(2)), NOW)).toBe("2d");
  });

  it("renders nothing for a stamp in the future", () => {
    expect(heldFor(new Date(NOW + DAY), NOW)).toBeNull();
  });

  it("renders nothing for a transition that just happened", () => {
    expect(heldFor(new Date(NOW - 2000), NOW)).toBeNull();
  });
});

describe("tones", () => {
  it("keeps every level and direction on an existing status token", () => {
    const tones = [
      stabilityTone("stable"),
      stabilityTone("watch"),
      stabilityTone("unstable"),
      stabilityTone("down"),
      stabilityTone("unknown"),
      trendTone("worsening"),
      trendTone("improving"),
      trendTone("steady"),
      incidentTone("crashed"),
      incidentTone("recovered"),
    ];
    for (const tone of tones) {
      expect(tone).toMatch(/^text-(status-(success|warning|error|neutral)|muted-foreground)$/);
    }
  });

  it("gives every level a surface", () => {
    for (const level of ["stable", "watch", "unstable", "down", "unknown"] as const) {
      expect(stabilitySurface(level)).toMatch(/^border-/);
    }
  });

  it("labels every incident kind", () => {
    const kinds = ["crashed", "crash-looping", "recovered", "deploy-failed", "rolled-back", "deploy-incomplete"] as const;
    for (const kind of kinds) expect(incidentLabel(kind)).toBeTruthy();
  });
});

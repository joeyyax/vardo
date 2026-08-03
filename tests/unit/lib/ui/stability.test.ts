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
  restartCue,
  restartsElevated,
  restartTone,
  stabilityCue,
  stabilitySurface,
  stabilityTone,
  stabilityTrend,
  stabilityVerdict,
  trendBadge,
  trendTone,
  RESTART_ORDINARY,
  TREND_WINDOW_MS,
  type Incident,
  type RestartReading,
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

function restarts(count: number, daysOld = 40): RestartReading {
  return { count, since: new Date(at(daysOld)).toISOString() };
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

  it("reads Vardo's own restart as its own kind", () => {
    const [incident] = buildIncidents(
      [{ action: "app.self_healed", createdAt: new Date(at(1)), metadata: { summary: "web was unhealthy" } }],
      [],
    );
    expect(incident.kind).toBe("self-healed");
    expect(incident.detail).toBe("web was unhealthy");
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

  it("does not count a self-heal, which would double the fault it answered", () => {
    expect(isFault("self-healed")).toBe(false);
    const trend = stabilityTrend(
      [fault(1), fault(1, "self-healed")],
      NOW,
      new Date(NOW - 60 * DAY),
    );
    expect(trend.recent).toBe(1);
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
      restarts: restarts(0),
      ...overrides,
    });
  }

  it("calls a clean running app with no history stable", () => {
    expect(verdict()).toMatchObject({ level: "stable", headline: "Stable", detail: null });
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

  it("leaves the last incident to the stat rather than repeating it", () => {
    const result = verdict({ incidents: [fault(20)] });
    expect(result).toMatchObject({ level: "stable", detail: null });
  });

  it("will not call an app with a restarting container stable", () => {
    const result = verdict({ restarts: restarts(12) });
    expect(result).toMatchObject({ level: "watch", headline: "Running" });
    expect(result.detail).toBe("12 restarts on the container running now, none recorded as incidents");
  });

  it("lets a container absorb a reboot or two without losing stable", () => {
    expect(verdict({ restarts: restarts(RESTART_ORDINARY) }).level).toBe("stable");
    expect(verdict({ restarts: restarts(RESTART_ORDINARY + 1) }).level).toBe("watch");
  });

  it("never takes the restart count past watch", () => {
    expect(verdict({ restarts: restarts(500) }).level).toBe("watch");
  });

  it("leaves a worse verdict alone rather than restating the count", () => {
    expect(verdict({ status: "error", exitReason: OOM, restarts: restarts(12) }).headline).toBe("Down");
    expect(verdict({ status: "stopped", restarts: restarts(12) }).headline).toBe("Stopped");
    expect(verdict({ conditions: [condition("crash-looping", "critical")], restarts: restarts(12) }).level)
      .toBe("unstable");
  });

  it("adds the count to the trend rather than claiming the app is clean now", () => {
    const incidents = [fault(3), fault(5)];
    const trend = stabilityTrend(incidents, NOW, new Date(NOW - 60 * DAY));
    const result = verdict({ incidents, trend, restarts: restarts(12) });

    expect(result.detail).toBe("2 incidents, up from 0, 12 restarts on this container");
    expect(result.detail).not.toContain("clean right now");
  });

  it("stays stable when Docker could not be read rather than guessing", () => {
    expect(verdict({ restarts: null }).level).toBe("stable");
  });
});

describe("restart count", () => {
  it("treats a count only above the ordinary band as elevated", () => {
    expect(restartsElevated(restarts(RESTART_ORDINARY))).toBe(false);
    expect(restartsElevated(restarts(RESTART_ORDINARY + 1))).toBe(true);
    expect(restartsElevated(null)).toBe(false);
  });

  it("paints the figure only once it stops being ordinary", () => {
    expect(restartTone(restarts(0))).toBe("text-foreground");
    expect(restartTone(restarts(12))).toBe("text-status-warning");
  });

  it("gives a row the count and nothing when there is none worth carrying", () => {
    expect(restartCue(restarts(1))).toBeNull();
    expect(restartCue(null)).toBeNull();
    expect(restartCue(restarts(12))).toMatchObject({ label: "12 restarts", tone: "text-status-warning" });
  });

  // A compose parent sums the count over its services, so a title naming one
  // container is wrong for every stack.
  it("titles the count without claiming a single container", () => {
    const title = restartCue(restarts(12))!.title;
    expect(title).toContain("containers running now");
    expect(title).not.toMatch(/\bthe container running now\b/);
  });
});

describe("stabilityCue", () => {
  const oldEnough = new Date(NOW - 60 * DAY);

  it("gives durable incidents the header before the live count", () => {
    const trend = stabilityTrend([fault(1), fault(2)], NOW, oldEnough);
    expect(stabilityCue(trend, restarts(12))).toBe("2 in 7d, up");
  });

  it("falls back to the live count when nothing durable was recorded", () => {
    expect(stabilityCue(stabilityTrend([], NOW, oldEnough), restarts(12))).toBe("12 restarts");
  });

  it("says nothing when neither source has anything", () => {
    expect(stabilityCue(stabilityTrend([], NOW, oldEnough), restarts(0))).toBeNull();
    expect(stabilityCue(stabilityTrend([], NOW, oldEnough), null)).toBeNull();
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

  it("keeps the age in days, where the Created date beside it can check it", () => {
    expect(restartCaption(restarts(12, 47), NOW)).toContain("created 47d ago");
    expect(restartCaption(restarts(7, 412), NOW)).toContain("created 412d ago");
  });

  it("drops below a day rather than rounding an hours-old container up", () => {
    const hours = new Date(NOW - 5 * 60 * 60 * 1000).toISOString();
    expect(restartCaption({ count: 3, since: hours }, NOW)).toContain("created 5h ago");
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
      incidentTone("self-healed"),
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
    const kinds = ["crashed", "crash-looping", "recovered", "self-healed", "deploy-failed", "rolled-back", "deploy-incomplete"] as const;
    for (const kind of kinds) expect(incidentLabel(kind)).toBeTruthy();
  });
});

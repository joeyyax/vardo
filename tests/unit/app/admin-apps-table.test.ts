import { describe, it, expect } from "vitest";
import type { AppRow } from "@/lib/admin-apps/types";
import type { PipelineDeploy } from "@/lib/pipeline/types";
import { filterApps, groupApps, nearLimit, rowTone, sortApps, subLine, summarize } from "@/app/(authenticated)/admin/apps/table";
import { seriesPaths } from "@/app/(authenticated)/admin/apps/chart";

// The Apps table's rules: row state, filter, groups, sort and the header sentence.

const T = 1_800_000_000_000;
const MB = 1024 ** 2;

function app(over: Partial<AppRow> = {}): AppRow {
  return {
    id: over.name ?? "a",
    slug: over.name ?? "a",
    name: "a",
    orgId: "o1",
    orgName: "Acme",
    orgSlug: "acme",
    projectName: "Site",
    status: "active",
    deploy: null,
    down: false,
    cpu: 10,
    cpuLimit: null,
    memory: 100 * MB,
    memoryLimit: 512 * MB,
    rx: 1000,
    tx: 2000,
    spark: { cpu: [], memory: [], net: [] },
    uptime: 1,
    lastDeploy: null,
    ribbon: { deploys: [], backups: [], crons: [], outages: [] },
    ...over,
  };
}

function deploy(over: Partial<PipelineDeploy> = {}): PipelineDeploy {
  return {
    id: "d1",
    appId: "a",
    appName: "a",
    appSlug: "a",
    orgName: "Acme",
    status: "running",
    stage: "build",
    stop: "build",
    waiting: false,
    waitReason: null,
    failed: false,
    gone: false,
    builder: "local",
    builderName: "jy0",
    fellBack: false,
    label: "Building",
    queuedAt: T,
    stageSince: T,
    finishedAt: null,
    claimSlot: null,
    segments: [
      { stage: "queued", start: T, end: T + 1000 },
      { stage: "build", start: T + 1000, end: null },
    ],
    transfer: null,
    queue: null,
    next: null,
    rollback: false,
    failure: null,
    ...over,
  } as PipelineDeploy;
}

describe("row state", () => {
  it("puts an outage first, then a wait for a builder, then a running deploy", () => {
    expect(rowTone(app({ down: true, deploy: deploy() }))).toBe("issue");
    const waiting = deploy({ waitReason: "build-slot", waiting: true, segments: [{ stage: "wait", start: T, end: null }] });
    expect(rowTone(app({ deploy: waiting }))).toBe("warn");
    expect(subLine(app({ deploy: waiting }), "org")).toEqual({ text: "Waiting for a builder", tone: "warn" });
    expect(rowTone(app({ deploy: deploy() }))).toBe("active");
    expect(subLine(app({ deploy: deploy() }), "org").text).toBe("Building on jy0");
    expect(rowTone(app({ status: "stopped" }))).toBe("stopped");
  });

  it("names the other grouping under the app when nothing is happening", () => {
    expect(subLine(app(), "org").text).toBe("Site");
    expect(subLine(app(), "project").text).toBe("Acme");
    expect(subLine(app({ status: "stopped" }), "none").text).toBe("Acme · Site · Stopped");
  });

  it("calls memory near its limit at 85%", () => {
    expect(nearLimit(app({ memory: 450 * MB }))).toBe(true);
    expect(nearLimit(app({ memory: 400 * MB }))).toBe(false);
    expect(nearLimit(app({ memory: 450 * MB, memoryLimit: null }))).toBe(false);
  });
});

describe("filter, sort and group", () => {
  const list = [
    app({ id: "1", name: "pouch", cpu: 5, orgId: "o1", orgName: "Joey", projectName: "Pouch" }),
    app({ id: "2", name: "knowledge", cpu: null, orgId: "o1", orgName: "Joey", projectName: "Platform" }),
    app({ id: "3", name: "wha-site", cpu: 75, orgId: "o2", orgName: "WHA", projectName: "Web" }),
  ];

  it("matches name, org or project", () => {
    expect(filterApps(list, "joey").map((a) => a.name)).toEqual(["pouch", "knowledge"]);
    expect(filterApps(list, " WEB ").map((a) => a.name)).toEqual(["wha-site"]);
  });

  it("sorts either way with missing values last", () => {
    expect(sortApps(list, { key: "cpu", dir: "desc" }).map((a) => a.name)).toEqual(["wha-site", "pouch", "knowledge"]);
    expect(sortApps(list, { key: "cpu", dir: "asc" }).map((a) => a.name)).toEqual(["pouch", "wha-site", "knowledge"]);
  });

  it("groups biggest first with a memory sum", () => {
    const groups = groupApps(list, "org", { key: "name", dir: "asc" });
    expect(groups.map((g) => [g.name, g.apps.length])).toEqual([["Joey", 2], ["WHA", 1]]);
    expect(groups[0].memory).toBe(200 * MB);
    expect(groupApps(list, "none", { key: "name", dir: "asc" })).toHaveLength(1);
    expect(groupApps(list, "project", { key: "name", dir: "asc" })).toHaveLength(3);
  });
});

describe("summarize", () => {
  it("counts what needs a look", () => {
    const list = [app({ deploy: deploy() }), app({ memory: 500 * MB }), app()];
    expect(summarize({ apps: list })).toBe("3 apps. 1 deploying, 1 near its memory limit.");
    expect(summarize({ apps: [app()] })).toBe("1 app. Nothing needs attention.");
    expect(summarize({ apps: [] })).toBe("No apps on this instance yet.");
  });
});

describe("seriesPaths", () => {
  it("breaks the line at gaps", () => {
    const { line } = seriesPaths([1, 2, null, 3, 4], 40, 10, 4);
    expect(line.match(/M/g)).toHaveLength(2);
  });
});

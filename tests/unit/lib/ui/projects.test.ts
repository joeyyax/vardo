import { describe, expect, it } from "vitest";
import type { AppCondition } from "@/lib/docker/conditions";
import { problem } from "@/lib/ui/conditions";
import { statusMarkTone } from "@/lib/ui/status-colors";
import {
  buildSections,
  buildTree,
  fleetCounts,
  issueGroups,
  markSubject,
  sortNodes,
  type ProjectsApp,
} from "@/lib/ui/projects";

function app(name: string, o: Partial<ProjectsApp> = {}): ProjectsApp {
  return {
    id: name,
    name,
    displayName: name,
    projectId: "p1",
    status: "active",
    parked: false,
    kind: "web",
    conditions: null,
    exitReason: null,
    needsRedeploy: false,
    imageName: null,
    gitUrl: null,
    composeService: null,
    dependsOn: null,
    priority: "standard",
    gpuEnabled: false,
    containerStartedAt: null,
    lastRunningAt: null,
    statusChangedAt: null,
    restartCount: null,
    domains: [],
    deployments: [],
    lastBackupAt: null,
    services: [],
    ...o,
  };
}

const cond = (kind: AppCondition["kind"], severity: AppCondition["severity"], since = "2026-10-01T00:00:00.000Z"): AppCondition => ({
  kind,
  severity,
  since,
  detail: "detail",
});

describe("problem", () => {
  it("is null for a healthy app and for one stopped on purpose", () => {
    expect(problem({ name: "a", status: "active" })).toBeNull();
    expect(problem({ name: "a", status: "error", parked: true })).toBeNull();
  });

  it("names a failed deploy with its start as the since and a retry", () => {
    const p = problem({ name: "a", status: "error", latestDeploy: { status: "failed", startedAt: "2026-10-10T01:00:00.000Z" } });
    expect(p).toMatchObject({ group: "failed", tone: "error", title: "Deploy failed", since: "2026-10-10T01:00:00.000Z" });
    expect(p?.fix).toEqual({ label: "Retry deploy", run: "deploy" });
  });

  it("dates a missing container from when it was last seen running", () => {
    const p = problem({ name: "a", status: "missing", lastRunningAt: "2026-09-29T00:00:00.000Z" });
    expect(p).toMatchObject({ group: "missing", since: "2026-09-29T00:00:00.000Z" });
  });

  it("puts a critical condition ahead of a missing container", () => {
    const p = problem({ name: "a", status: "missing", conditions: [cond("crash-looping", "critical")] });
    expect(p?.group).toBe("crash");
  });

  it("leaves a service in its parent's state to the parent", () => {
    expect(problem({ name: "s", status: "missing", parentStatus: "missing" })).toBeNull();
    expect(problem({ name: "s", status: "missing", parentStatus: "active" })?.group).toBe("missing");
  });

  it("uses the condition's since", () => {
    const p = problem({ name: "a", status: "active", conditions: [cond("backup-stale", "warning", "2026-10-07T00:00:00.000Z")] });
    expect(p).toMatchObject({ group: "backups", title: "Backup overdue", since: "2026-10-07T00:00:00.000Z" });
  });

  it("reports a pending config change last", () => {
    expect(problem({ name: "a", status: "active", needsRedeploy: true })?.group).toBe("config");
  });
});

describe("statusMarkTone", () => {
  it("draws stopped as stopped even when something inside is wrong", () => {
    expect(statusMarkTone({ name: "a", status: "stopped", children: [{ name: "b", status: "error" }] }).tone).toBe("stopped");
  });

  it("takes the worst state of its children", () => {
    const mark = statusMarkTone({
      name: "a",
      status: "active",
      children: [
        { name: "b", status: "active", parentStatus: "active", conditions: [cond("memory-pressure", "warning")] },
        { name: "c", status: "active", parentStatus: "active" },
      ],
    });
    expect(mark).toMatchObject({ tone: "warn", label: "Needs attention" });
  });

  it("rings a deploy", () => {
    expect(statusMarkTone({ name: "a", status: "deploying" })).toMatchObject({ tone: "info", pending: true });
  });
});

describe("buildTree", () => {
  it("nests a database, cache or worker under the one app using it", () => {
    const tree = buildTree([
      app("api", { dependsOn: ["db", "cache", "auth"] }),
      app("db", { kind: "database" }),
      app("cache", { kind: "cache" }),
      app("auth", { kind: "web" }),
    ]);
    expect(tree.map((n) => n.app.name).sort()).toEqual(["api", "auth"]);
    const api = tree.find((n) => n.app.name === "api")!;
    expect(api.children.map((c) => [c.app.name, c.relation])).toEqual([
      ["db", "dependency"],
      ["cache", "dependency"],
    ]);
  });

  it("keeps an app top level when it depends back", () => {
    const tree = buildTree([app("api", { dependsOn: ["jobs"] }), app("jobs", { kind: "worker", dependsOn: ["api"] })]);
    expect(tree).toHaveLength(2);
  });

  it("nests compose services under their app", () => {
    const tree = buildTree([app("stack", { services: [app("stack-web"), app("stack-db", { kind: "database" })] })]);
    expect(tree[0].children.map((c) => c.relation)).toEqual(["service", "service"]);
  });
});

describe("sortNodes", () => {
  it("puts problems first and stopped on purpose last", () => {
    const sorted = sortNodes(
      buildTree([
        app("a-fine"),
        app("b-parked", { parked: true, status: "stopped" }),
        app("c-broken", { status: "error" }),
        app("d-parent", { services: [app("d-svc", { conditions: [cond("unhealthy", "warning")] })] }),
      ]),
    );
    expect(sorted.map((n) => n.app.name)).toEqual(["c-broken", "d-parent", "a-fine", "b-parked"]);
  });

  it("marks a folded parent by its worst service", () => {
    const [node] = buildTree([app("p", { services: [app("p-svc", { status: "error" })] })]);
    expect(statusMarkTone(markSubject(node)).tone).toBe("issue");
  });
});

describe("issueGroups", () => {
  it("groups open problems worst group first and counts them for the page", () => {
    const sections = buildSections(
      [{ id: "p1", name: "one", displayName: "One", isSystemManaged: false }],
      [
        app("a", { conditions: [cond("backup-missing", "warning")] }),
        app("b", { status: "error" }),
        app("c", { conditions: [cond("backup-stale", "warning")] }),
      ],
    );
    const groups = issueGroups(sections);
    expect(groups.map((g) => [g.key, g.items.length])).toEqual([
      ["failed", 1],
      ["backups", 2],
    ]);
    expect(fleetCounts(sections)).toMatchObject({ attention: 3, critical: 1, backupsOverdue: 2, running: 2 });
  });
});

import { describe, expect, it } from "vitest";
import { PROJECT_SORTS } from "@/lib/db/schema/enums";
import {
  buildSections,
  buildTree,
  isProjectSort,
  SORT_LABEL,
  sortNodes,
  type ProjectsApp,
  type ProjectsDeployment,
  type ProjectsProject,
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
    createdAt: null,
    domains: [],
    tags: [],
    deployments: [],
    lastBackupAt: null,
    services: [],
    ...o,
  };
}

function project(id: string, o: Partial<ProjectsProject> = {}): ProjectsProject {
  return { id, name: id, displayName: id, isSystemManaged: false, createdAt: null, ...o };
}

const deployed = (startedAt: string): ProjectsDeployment[] => [
  { id: `d-${startedAt}`, status: "success", trigger: null, gitSha: null, startedAt, finishedAt: startedAt, durationMs: 1 },
];

// Each app wins under a different order.
const APPS = [
  app("alpha", { createdAt: "2026-01-01T00:00:00Z", deployments: deployed("2026-03-01T00:00:00Z") }),
  app("bravo", { status: "error", createdAt: "2026-02-01T00:00:00Z", deployments: deployed("2026-02-01T00:00:00Z") }),
  app("charlie", { createdAt: "2026-04-01T00:00:00Z", deployments: deployed("2026-01-01T00:00:00Z") }),
  app("delta", { createdAt: "2026-03-01T00:00:00Z", deployments: deployed("2026-04-01T00:00:00Z") }),
];

const names = (sort: Parameters<typeof sortNodes>[1], starred?: Set<string>) =>
  sortNodes(buildTree(APPS), sort, starred).map((n) => n.app.name);

describe("app order", () => {
  it("defaults to needs attention first, the original order", () => {
    expect(names(undefined)).toEqual(["bravo", "alpha", "charlie", "delta"]);
  });

  it.each([
    ["name", ["alpha", "bravo", "charlie", "delta"]],
    ["deployed", ["delta", "alpha", "bravo", "charlie"]],
    ["created", ["charlie", "delta", "bravo", "alpha"]],
    ["attention", ["bravo", "alpha", "charlie", "delta"]],
  ] as const)("sorts by %s", (sort, expected) => {
    expect(names(sort)).toEqual(expected);
  });

  it.each(PROJECT_SORTS)("puts starred apps first under %s, keeping the order among them", (sort) => {
    const plain = names(sort);
    const starred = new Set(["charlie", "alpha"]);
    const sorted = names(sort, starred);
    expect(new Set(sorted.slice(0, 2))).toEqual(starred);
    expect(sorted.slice(0, 2)).toEqual(plain.filter((n) => starred.has(n)));
    expect(sorted.slice(2)).toEqual(plain.filter((n) => !starred.has(n)));
  });

  it("orders by the newest deploy anywhere in a stack", () => {
    const stack = app("stack", { services: [app("svc", { deployments: deployed("2026-05-01T00:00:00Z") })] });
    expect(sortNodes(buildTree([...APPS, stack]), "deployed").map((n) => n.app.name)[0]).toBe("stack");
  });

  it("sorts services and dependencies under their parent too", () => {
    const parent = app("parent", { services: [app("zulu"), app("yankee", { createdAt: "2026-01-01T00:00:00Z" })] });
    const [node] = sortNodes(buildTree([parent]), "name");
    expect(node.children.map((c) => c.app.name)).toEqual(["yankee", "zulu"]);
  });
});

describe("project order", () => {
  const projects = [
    project("p-broken", { displayName: "Charlie", createdAt: "2026-01-01T00:00:00Z" }),
    project("p-new", { displayName: "Bravo", createdAt: "2026-03-01T00:00:00Z" }),
    project("p-old", { displayName: "Alpha", createdAt: "2026-02-01T00:00:00Z" }),
    project("p-empty", { displayName: "Aardvark", createdAt: "2026-04-01T00:00:00Z" }),
  ];
  const apps = [
    app("x", { projectId: "p-broken", status: "error", deployments: deployed("2026-01-01T00:00:00Z") }),
    app("y", { projectId: "p-new", deployments: deployed("2026-02-01T00:00:00Z") }),
    app("z", { projectId: "p-old", deployments: deployed("2026-03-01T00:00:00Z") }),
  ];
  const ids = (opts?: Parameters<typeof buildSections>[2]) => buildSections(projects, apps, opts).map((s) => s.project.id);

  it("defaults to needs attention first with empty projects last", () => {
    expect(ids()).toEqual(["p-broken", "p-old", "p-new", "p-empty"]);
  });

  it.each([
    ["name", ["p-empty", "p-old", "p-new", "p-broken"]],
    ["deployed", ["p-old", "p-new", "p-broken", "p-empty"]],
    ["created", ["p-empty", "p-new", "p-old", "p-broken"]],
    ["attention", ["p-broken", "p-old", "p-new", "p-empty"]],
  ] as const)("sorts by %s", (sort, expected) => {
    expect(ids({ sort })).toEqual(expected);
  });

  it.each(PROJECT_SORTS)("puts starred projects first under %s", (sort) => {
    const plain = ids({ sort });
    const starred = { projects: new Set(["p-empty"]), apps: new Set<string>() };
    expect(ids({ sort, starred })).toEqual(["p-empty", ...plain.filter((id) => id !== "p-empty")]);
  });

  it("passes app stars to every project's rows", () => {
    const two = [app("a", { projectId: "p-new" }), app("b", { projectId: "p-new" })];
    const starred = { projects: new Set<string>(), apps: new Set(["b"]) };
    const [section] = buildSections([project("p-new")], two, { sort: "name", starred });
    expect(section.nodes.map((n) => n.app.name)).toEqual(["b", "a"]);
  });
});

describe("isProjectSort", () => {
  it("labels every stored order and accepts only those", () => {
    expect(Object.keys(SORT_LABEL).sort()).toEqual([...PROJECT_SORTS].sort());
    for (const sort of PROJECT_SORTS) expect(isProjectSort(sort)).toBe(true);
    expect(isProjectSort("toString")).toBe(false);
    expect(isProjectSort(null)).toBe(false);
  });
});

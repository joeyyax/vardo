import { describe, it, expect } from "vitest";
import {
  attentionRank,
  filterApps,
  isSortKey,
  lastDeployedAt,
  matchesApp,
  matchesProject,
  sortProjectCards,
  type FilterableApp,
  type SortableCard,
} from "@/lib/ui/app-filter";

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function app(overrides: Partial<FilterableApp> = {}): FilterableApp {
  return {
    name: "plex",
    displayName: "Plex",
    domains: [{ domain: "plex.example.com" }],
    project: { name: "media", displayName: "Media" },
    ...overrides,
  };
}

describe("matchesApp", () => {
  it("matches the app's own name, case insensitively", () => {
    expect(matchesApp(app(), "PLE")).toBe(true);
  });

  it("matches a domain", () => {
    expect(matchesApp(app(), "example.com")).toBe(true);
  });

  it("matches the project name, so a project search keeps its apps", () => {
    expect(matchesApp(app(), "media")).toBe(true);
  });

  it("requires every term to match", () => {
    expect(matchesApp(app(), "plex media")).toBe(true);
    expect(matchesApp(app(), "plex sonarr")).toBe(false);
  });

  it("matches everything on an empty query", () => {
    expect(matchesApp(app(), "   ")).toBe(true);
  });
});

describe("filterApps", () => {
  const apps = [
    app(),
    app({ name: "sonarr", displayName: "Sonarr", domains: [], project: { name: "media", displayName: "Media" } }),
    app({ name: "wiki", displayName: "Wiki", domains: [{ domain: "wiki.internal" }], project: { name: "docs", displayName: "Docs" } }),
  ];

  it("keeps every app of a project matched by name", () => {
    expect(filterApps(apps, "media").map((a) => a.name)).toEqual(["plex", "sonarr"]);
  });

  it("keeps only the matching app when the term names one", () => {
    expect(filterApps(apps, "wiki").map((a) => a.name)).toEqual(["wiki"]);
  });

  it("returns the same array when nothing is typed", () => {
    expect(filterApps(apps, "")).toBe(apps);
  });
});

describe("matchesProject", () => {
  it("matches slug or display name", () => {
    expect(matchesProject({ name: "media", displayName: "Media" }, "MED")).toBe(true);
    expect(matchesProject({ name: "media", displayName: "Media" }, "docs")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

function card(displayName: string, apps: SortableCard["apps"]): SortableCard {
  return { project: { displayName }, apps };
}

describe("attentionRank", () => {
  it("ranks a crashed app worst", () => {
    expect(attentionRank(card("A", [{ status: "error" }]))).toBe(0);
  });

  it("does not raise a card for a parked app, however it reads", () => {
    const c = card("A", [
      { status: "error", parked: true },
      { status: "missing", parked: true, conditions: [{ kind: "crash-looping", severity: "critical", detail: "5 restarts", since: "" }] },
    ]);
    expect(attentionRank(c)).toBe(2);
  });

  it("ranks a critical condition alongside a crash", () => {
    const c = card("A", [
      { status: "active", conditions: [{ kind: "crash-looping", severity: "critical", detail: "5 restarts", since: "" }] },
    ]);
    expect(attentionRank(c)).toBe(0);
  });

  it("ranks a warning condition below a crash and above quiet", () => {
    const warned = card("A", [
      { status: "active", conditions: [{ kind: "backup-stale", severity: "warning", detail: "8 days", since: "" }] },
    ]);
    expect(attentionRank(warned)).toBe(1);
    expect(attentionRank(card("B", [{ status: "active" }]))).toBe(2);
  });

  it("leaves a stopped app quiet — stopping one is deliberate", () => {
    expect(attentionRank(card("A", [{ status: "stopped" }]))).toBe(2);
    expect(attentionRank(card("B", [{ status: "missing" }]))).toBe(1);
  });

  it("ranks an empty project quiet", () => {
    expect(attentionRank(card("A", []))).toBe(2);
  });
});

describe("lastDeployedAt", () => {
  it("takes the most recent deployment across the card's apps", () => {
    const c = card("A", [
      { status: "active", deployments: [{ startedAt: "2026-01-01T00:00:00Z" }] },
      { status: "active", deployments: [{ startedAt: "2026-03-01T00:00:00Z" }] },
    ]);
    expect(lastDeployedAt(c)).toBe(Date.parse("2026-03-01T00:00:00Z"));
  });

  it("is null when nothing has deployed", () => {
    expect(lastDeployedAt(card("A", [{ status: "active" }]))).toBeNull();
  });
});

describe("sortProjectCards", () => {
  const crashed = card("Zeta", [{ status: "error", deployments: [{ startedAt: "2026-01-01T00:00:00Z" }] }]);
  const warned = card("Alpha", [
    { status: "missing", deployments: [{ startedAt: "2026-05-01T00:00:00Z" }] },
  ]);
  const quiet = card("Beta", [{ status: "active", deployments: [{ startedAt: "2026-06-01T00:00:00Z" }] }]);
  const never = card("Omega", [{ status: "active" }]);
  const cards = [quiet, never, crashed, warned];

  it("puts trouble first by default", () => {
    expect(sortProjectCards(cards, "attention").map((c) => c.project.displayName)).toEqual([
      "Zeta",
      "Alpha",
      "Beta",
      "Omega",
    ]);
  });

  it("sorts by name", () => {
    expect(sortProjectCards(cards, "name").map((c) => c.project.displayName)).toEqual([
      "Alpha",
      "Beta",
      "Omega",
      "Zeta",
    ]);
  });

  it("sorts newest deploy first and never-deployed last", () => {
    expect(sortProjectCards(cards, "deployed").map((c) => c.project.displayName)).toEqual([
      "Beta",
      "Alpha",
      "Zeta",
      "Omega",
    ]);
  });

  it("does not mutate the input", () => {
    const input = [...cards];
    sortProjectCards(input, "name");
    expect(input).toEqual(cards);
  });
});

describe("isSortKey", () => {
  it("accepts the three controls and nothing else", () => {
    expect(isSortKey("attention")).toBe(true);
    expect(isSortKey("deployed")).toBe(true);
    expect(isSortKey("size")).toBe(false);
  });
});

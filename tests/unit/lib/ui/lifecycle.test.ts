import { describe, it, expect } from "vitest";

import {
  buildLifecycleEvents,
  interleaveHistory,
  lifecycleDetail,
  lifecycleLabel,
  lifecycleNotes,
  LIFECYCLE_ACTIONS,
  partitionLifecycle,
  type LifecycleEvent,
  type LifecycleRow,
} from "@/lib/ui/lifecycle";
import { STABILITY_ACTIONS } from "@/lib/ui/stability";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function at(hoursAgo: number): Date {
  return new Date(NOW - hoursAgo * HOUR);
}

function row(overrides: Partial<LifecycleRow> = {}): LifecycleRow {
  return {
    id: "r1",
    action: "app.restarted",
    createdAt: at(1),
    metadata: { scope: "app" },
    user: { name: "Joey", email: "joey@example.com" },
    ...overrides,
  };
}

function event(hoursAgo: number, id = `e${hoursAgo}`): LifecycleEvent {
  return {
    id,
    kind: "restarted",
    at: at(hoursAgo).getTime(),
    label: "Restarted",
    detail: "by Joey",
    durationMs: null,
    notes: [],
  };
}

describe("buildLifecycleEvents", () => {
  it("reads each action as its own kind, newest first", () => {
    const events = buildLifecycleEvents([
      row({ id: "a", action: "app.stopped", createdAt: at(3) }),
      row({ id: "b", action: "app.started", createdAt: at(2) }),
      row({ id: "c", action: "app.restarted", createdAt: at(1) }),
    ]);

    expect(events.map((e) => e.kind)).toEqual(["restarted", "started", "stopped"]);
  });

  it("drops rows it has no kind for and rows with no usable date", () => {
    const events = buildLifecycleEvents([
      row({ action: "app.self_healed" }),
      row({ action: "deployment.succeeded" }),
      row({ createdAt: "not a date" }),
    ]);

    expect(events).toEqual([]);
  });

  it("carries the outcome, the span and the pending config through", () => {
    const [e] = buildLifecycleEvents([
      row({ metadata: { scope: "app", status: "error", durationMs: 1200, needsRedeploy: true } }),
    ]);

    expect(e.durationMs).toBe(1200);
    expect(e.notes.map((n) => n.label)).toEqual(["now crashed", "config still pending"]);
  });

  it("claims nothing for a row written before any of it was recorded", () => {
    const [e] = buildLifecycleEvents([row({ metadata: { scope: "app", trigger: "mcp" } })]);

    expect(e.notes).toEqual([]);
    expect(e.durationMs).toBeNull();
    expect(e.label).toBe("Restarted");
    expect(e.detail).toBe("by Joey via MCP");
  });

  it("renders a row with no metadata at all", () => {
    const [e] = buildLifecycleEvents([row({ metadata: null })]);

    expect(e.label).toBe("Restarted");
    expect(e.notes).toEqual([]);
    expect(e.durationMs).toBeNull();
  });

  it("ignores metadata it cannot read as a status or a span", () => {
    const [e] = buildLifecycleEvents([
      row({ metadata: { status: "banana", durationMs: "quick", needsRedeploy: "yes" } }),
    ]);

    expect(e.notes).toEqual([]);
    expect(e.durationMs).toBeNull();
  });

  it("reads no status off a name Object itself answers to", () => {
    const [e] = buildLifecycleEvents([row({ metadata: { status: "constructor" } })]);
    expect(e.notes).toEqual([]);
  });

  it("drops a negative span rather than reporting one", () => {
    const [e] = buildLifecycleEvents([row({ metadata: { durationMs: -1 } })]);
    expect(e.durationMs).toBeNull();
  });

  it("keeps Vardo's own restarts off this timeline entirely", () => {
    const overlap = LIFECYCLE_ACTIONS.filter((a) =>
      (STABILITY_ACTIONS as readonly string[]).includes(a),
    );
    expect(overlap).toEqual([]);
    expect(STABILITY_ACTIONS).toContain("app.self_healed");
  });
});

describe("lifecycleLabel", () => {
  it("names the service a compose child restarted, and the stack a parent did", () => {
    expect(lifecycleLabel("restarted", "service", "api")).toBe("Restarted the api service");
    expect(lifecycleLabel("restarted", "stack")).toBe("Restarted the stack");
    expect(lifecycleLabel("restarted", "app")).toBe("Restarted");
  });

  it("falls back to the bare verb when a service scope carries no name", () => {
    expect(lifecycleLabel("stopped", "service", null)).toBe("Stopped");
  });
});

describe("lifecycleDetail", () => {
  it("names the person, falling back to their email", () => {
    expect(lifecycleDetail({ name: "Joey", email: "joey@example.com" })).toBe("by Joey");
    expect(lifecycleDetail({ name: null, email: "joey@example.com" })).toBe("by joey@example.com");
  });

  it("says Vardo when no one is on the row", () => {
    expect(lifecycleDetail(null)).toBe("by Vardo");
  });

  it("uppercases the acronyms a trigger uses", () => {
    expect(lifecycleDetail({ name: "Joey", email: "j@e.com" }, "api")).toBe("by Joey via API");
    expect(lifecycleDetail({ name: "Joey", email: "j@e.com" }, "mcp")).toBe("by Joey via MCP");
  });
});

describe("lifecycleNotes", () => {
  it("says nothing when the action left the app as it meant to", () => {
    expect(lifecycleNotes("restarted", "active")).toEqual([]);
    expect(lifecycleNotes("started", "active")).toEqual([]);
    expect(lifecycleNotes("stopped", "stopped")).toEqual([]);
  });

  it("names the status a restart came back as, when it is not running", () => {
    expect(lifecycleNotes("restarted", "error")[0]).toMatchObject({
      label: "now crashed",
      tone: "text-status-error",
    });
    expect(lifecycleNotes("restarted", "missing")[0].label).toBe("no container");
    expect(lifecycleNotes("restarted", "stopped")[0].label).toBe("now stopped");
  });

  it("reads a stop against what a stop was for — running is the failure there", () => {
    expect(lifecycleNotes("stopped", "active")[0]).toMatchObject({
      label: "now running",
      tone: "text-status-warning",
    });
    expect(lifecycleNotes("stopped", "missing")[0].label).toBe("no container");
  });

  it("says nothing at all when no status was recorded", () => {
    expect(lifecycleNotes("restarted")).toEqual([]);
    expect(lifecycleNotes("restarted", null)).toEqual([]);
  });

  it("warns that the config is still waiting on a deploy", () => {
    expect(lifecycleNotes("restarted", "active", true)).toEqual([
      expect.objectContaining({ label: "config still pending", tone: "text-status-warning" }),
    ]);
  });

  it("leads with the outcome and keeps the pending config behind it", () => {
    expect(lifecycleNotes("restarted", "error", true).map((n) => n.label)).toEqual([
      "now crashed",
      "config still pending",
    ]);
  });
});

describe("partitionLifecycle", () => {
  it("splits at the release currently serving", () => {
    const { since, earlier } = partitionLifecycle([event(1), event(5)], at(3));
    expect(since.map((e) => e.id)).toEqual(["e1"]);
    expect(earlier.map((e) => e.id)).toEqual(["e5"]);
  });

  it("puts everything in history when nothing is serving", () => {
    const { since, earlier } = partitionLifecycle([event(1)], null);
    expect(since).toEqual([]);
    expect(earlier).toHaveLength(1);
  });
});

describe("interleaveHistory", () => {
  const deploy = (id: string, hoursAgo: number) => ({ id, finishedAt: at(hoursAgo) });

  it("orders deploys and lifecycle lines together, newest first", () => {
    const items = interleaveHistory(
      [deploy("d1", 2), deploy("d2", 6)],
      [event(1), event(4)],
      (d) => d.finishedAt,
    );

    expect(
      items.map((i) => (i.kind === "deploy" ? i.deploy.id : i.event.id)),
    ).toEqual(["e1", "d1", "e4", "d2"]);
  });

  it("keeps a deploy above a restart that landed on the same tick", () => {
    const items = interleaveHistory([deploy("d1", 2)], [event(2)], (d) => d.finishedAt);
    expect(items[0].kind).toBe("deploy");
  });

  it("returns the lifecycle lines alone when an app has never deployed", () => {
    const items = interleaveHistory<{ id: string; finishedAt: Date }>(
      [],
      [event(1)],
      (d) => d.finishedAt,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("lifecycle");
  });
});

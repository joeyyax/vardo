import { describe, it, expect } from "vitest";

import {
  detailsFor,
  formatDuration,
  phraseFor,
  subjectSummary,
} from "@/lib/activity/labels";
import { groupActivities } from "@/lib/activity/group";
import { classifyAll } from "@/lib/activity/taxonomy";
import type { ActivityRow } from "@/lib/activity/types";

let seq = 0;
function row(action: string, metadata: unknown): ActivityRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    action,
    metadata,
    createdAt: new Date("2026-07-31T12:00:00Z"),
    user: null,
    app: { id: "app-1", name: "paperless", displayName: "Paperless" },
  };
}

function groupOf(action: string, metadata: unknown) {
  return groupActivities(classifyAll([row(action, metadata)]))[0];
}

describe("phraseFor", () => {
  it("uses the written phrase for a known action", () => {
    expect(phraseFor("deployment.failed").text).toBe("failed to deploy");
  });

  it("marks a phrase that needs no subject as standalone", () => {
    expect(phraseFor("org.trusted_changed").standalone).toBe(true);
    expect(phraseFor("app.created").standalone).toBeUndefined();
  });

  it("falls back to a readable form of an unknown action", () => {
    expect(phraseFor("mesh.peer_flapped").text).toBe("mesh peer flapped");
  });

  it("phrases the lifecycle actions as something someone did", () => {
    expect(phraseFor("app.restarted").text).toBe("restarted");
    expect(phraseFor("app.stopped").text).toBe("stopped");
    expect(phraseFor("app.started").text).toBe("started");
  });
});

describe("formatDuration", () => {
  it("scales from milliseconds to minutes", () => {
    expect(formatDuration(400)).toBe("400ms");
    expect(formatDuration(4200)).toBe("4s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });
});

describe("detailsFor", () => {
  it("reports deploy duration", () => {
    expect(detailsFor(groupOf("deployment.succeeded", { durationMs: 45_000 }))).toEqual([
      "in 45s",
    ]);
  });

  it("reports what triggered a deploy", () => {
    expect(detailsFor(groupOf("deployment.started", { trigger: "webhook" }))).toEqual([
      "via webhook",
    ]);
  });

  it("keeps acronym triggers uppercase", () => {
    expect(detailsFor(groupOf("app.restarted", { trigger: "api" }))).toEqual(["via API"]);
    expect(detailsFor(groupOf("app.restarted", { trigger: "mcp" }))).toEqual(["via MCP"]);
  });

  it("lists what an update changed", () => {
    expect(
      detailsFor(groupOf("app.updated", { changes: ["name", "port"] }))
    ).toEqual(["name, port"]);
  });

  it("caps a long change list", () => {
    const details = detailsFor(
      groupOf("app.updated", { changes: ["a", "b", "c", "d", "e", "f"] })
    );
    expect(details[0]).toBe("a, b, c, d");
  });

  it("shows the image an update moved to", () => {
    expect(
      detailsFor(
        groupOf("app.image_updated", { service: "web", from: "v1", to: "v2" })
      )
    ).toEqual(["web → v2"]);
  });

  it("counts drifted files", () => {
    expect(detailsFor(groupOf("volume.drift_detected", { totalDrift: 1 }))).toEqual([
      "1 file",
    ]);
  });

  it("stays silent for a collapsed run, which has no single answer", () => {
    const group = groupActivities(
      classifyAll([
        row("deployment.succeeded", { durationMs: 1000 }),
        row("deployment.succeeded", { durationMs: 2000 }),
      ])
    )[0];

    expect(group.count).toBe(2);
    expect(detailsFor(group)).toEqual([]);
  });

  it("returns nothing when metadata is empty", () => {
    expect(detailsFor(groupOf("app.created", null))).toEqual([]);
  });
});

describe("subjectSummary", () => {
  it("shows all subjects when they fit", () => {
    expect(subjectSummary(["a", "b"])).toEqual({ shown: ["a", "b"], remainder: 0 });
  });

  it("counts the overflow", () => {
    expect(subjectSummary(["a", "b", "c", "d", "e"])).toEqual({
      shown: ["a", "b", "c"],
      remainder: 2,
    });
  });
});

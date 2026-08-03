// ---------------------------------------------------------------------------
// The deploy gate's decision, on its own.
//
// The two failure modes it must not have: reading an unknown major as "no
// change", and firing on uncertainty. Both are tested here rather than through
// the deploy, because both are decisions and not plumbing.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
  blockedService,
  majorGateBlockMessage,
  majorGateCandidates,
  majorGateLogLines,
  majorGateVerdict,
  type MajorGateCandidate,
} from "@/lib/docker/image-updates/major-gate";
import type { ImageMajor } from "@/lib/docker/image-updates/image-major";

const major = (n: number): ImageMajor => ({ major: n, source: "env", raw: String(n) });

const postgres: MajorGateCandidate = {
  service: "db",
  image: "postgres:latest",
  tag: "latest",
};

describe("majorGateCandidates", () => {
  it("takes major-locked images whose tag names no version", () => {
    const found = majorGateCandidates([
      { service: "db", image: "postgres:latest" },
      { service: "cache", image: "redis:latest" },
      { service: "web", image: "nginx:latest" },
      { service: "search", image: "elasticsearch:8" },
      { service: "docs", image: "mongo:alpine" },
    ]);

    expect(found.map((c) => c.service)).toEqual(["db", "docs"]);
  });

  it("skips a tag that already names the major", () => {
    expect(
      majorGateCandidates([
        { service: "db", image: "postgres:16" },
        { service: "alt", image: "postgres:17-alpine" },
        { service: "my", image: "mysql:8.0" },
      ]),
    ).toEqual([]);
  });

  it("skips a digest pin, which cannot move", () => {
    expect(
      majorGateCandidates([{ service: "db", image: "postgres@sha256:" + "a".repeat(64) }]),
    ).toEqual([]);
  });

  it("skips a service with no image, which is built rather than pulled", () => {
    expect(majorGateCandidates([{ service: "app", image: undefined }])).toEqual([]);
  });

  it("keeps redis out — its data survives a major", () => {
    expect(majorGateCandidates([{ service: "cache", image: "redis:latest" }])).toEqual([]);
  });
});

describe("majorGateVerdict", () => {
  it("blocks when the pull crossed a major", () => {
    expect(majorGateVerdict(postgres, major(16), major(18))).toMatchObject({
      kind: "changed",
      from: 16,
      to: 18,
    });
  });

  it("passes when the major held", () => {
    expect(majorGateVerdict(postgres, major(17), major(17)).kind).toBe("ok");
  });

  it("never reads an unreadable pulled image as no change", () => {
    const verdict = majorGateVerdict(postgres, major(16), null);
    expect(verdict.kind).toBe("unknown");
    expect(verdict.kind).not.toBe("ok");
  });

  it("never reads a missing local image as no change", () => {
    const verdict = majorGateVerdict(postgres, null, major(18));
    expect(verdict.kind).toBe("unknown");
    expect(verdict.kind).not.toBe("ok");
  });

  it("says which side it could not read", () => {
    expect(majorGateVerdict(postgres, null, major(18))).toMatchObject({
      reason: expect.stringContaining("before the pull"),
    });
    expect(majorGateVerdict(postgres, major(16), null)).toMatchObject({
      reason: expect.stringContaining("pulled image"),
    });
    expect(majorGateVerdict(postgres, null, null)).toMatchObject({
      reason: expect.stringContaining("before or after"),
    });
  });
});

describe("blockedService", () => {
  it("carries the engine's own migration path", () => {
    const entry = blockedService({ kind: "changed", candidate: postgres, from: 16, to: 18 });

    expect(entry.engine).toBe("postgres");
    expect(entry.plan?.strategy).toBe("dump-restore");
    expect(entry.plan?.steps.join(" ")).toContain("pg_dumpall");
    expect(entry.plan?.needsIntermediateSteps).toBe(false);
  });

  it("expands the hops an engine cannot jump", () => {
    const mongo: MajorGateCandidate = { service: "docs", image: "mongo:latest", tag: "latest" };
    const entry = blockedService({ kind: "changed", candidate: mongo, from: 5, to: 8 });

    expect(entry.plan?.needsIntermediateSteps).toBe(true);
    expect(entry.plan?.hops).toEqual([6, 7, 8]);
  });
});

describe("gate copy", () => {
  const blocked = [blockedService({ kind: "changed", candidate: postgres, from: 16, to: 18 })];

  it("says where the deploy stopped and what is still serving", () => {
    const message = majorGateBlockMessage("outline", blocked);

    expect(message).toContain("Stopped before the swap");
    expect(message).toContain("still serving");
    expect(message).toContain("nothing was replaced");
  });

  it("names the actual failure — a container that will not start", () => {
    expect(majorGateBlockMessage("outline", blocked)).toContain("exits on its version check");
  });

  it("does not claim the data is at risk", () => {
    const text = [majorGateBlockMessage("outline", blocked), ...majorGateLogLines("outline", blocked)]
      .join(" ")
      .toLowerCase();

    expect(text).not.toContain("data loss");
    expect(text).not.toContain("corrupt");
    expect(text).not.toContain("destroy");
    expect(text).toContain("the data is not altered");
  });

  it("offers both exits", () => {
    const lines = majorGateLogLines("outline", blocked).join(" ");

    expect(lines).toContain("Pin the tag to the major it is running");
    expect(lines).toContain("migrate the data");
  });
});

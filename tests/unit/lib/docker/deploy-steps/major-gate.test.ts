// ---------------------------------------------------------------------------
// Reading engine majors around the pre-pull.
//
// Env fixtures are the real ones off a live host: postgres carries GOSU_VERSION
// in the same block as PG_MAJOR, which a generic /MAJOR/ grep would return.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

const { inspectImageMeta, writeMajorGateBlock, dbMock } = vi.hoisted(() => ({
  inspectImageMeta: vi.fn(),
  writeMajorGateBlock: vi.fn(async () => {}),
  dbMock: { query: { deployments: { findFirst: vi.fn(async () => undefined) } } },
}));

vi.mock("@/lib/docker/client", () => ({ inspectImageMeta }));
vi.mock("@/lib/docker/image-updates/major-gate-store", () => ({ writeMajorGateBlock }));
vi.mock("@/lib/db", () => ({ db: dbMock }));

import {
  candidateKey,
  compareMajors,
  gateCandidates,
  majorGateAfter,
  majorGateBefore,
  observedMajors,
  readMajors,
  withRecordedBaseline,
} from "@/lib/docker/deploy-steps/major-gate";
import { DeployBlockedError } from "@/lib/docker/errors";
import type { DeployContext } from "@/lib/docker/deploy-context";

function pgEnv(major: number): string[] {
  return [
    "PATH=/usr/local/bin:/usr/bin",
    "GOSU_VERSION=1.19",
    "LANG=en_US.utf8",
    `PG_MAJOR=${major}`,
    `PG_VERSION=${major}.4-1.pgdg13+1`,
  ];
}

const candidate = { service: "db", image: "postgres:latest", tag: "latest" };

function context(services: Record<string, { image?: string }> = { db: { image: "postgres:latest" } }) {
  const logLines: string[] = [];
  return {
    deploymentId: "deploy-1",
    appId: "app-1",
    app: { name: "outline", displayName: "Outline", deployType: "compose" },
    compose: { services },
    log: (line: string) => {
      logLines.push(line);
      return line;
    },
    logLines,
  } as unknown as DeployContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.query.deployments.findFirst.mockResolvedValue(undefined);
});

describe("readMajors", () => {
  it("reads PG_MAJOR and not GOSU_VERSION", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: pgEnv(16), labels: {} });

    const reads = await readMajors([candidate]);
    expect(reads.get(candidateKey(candidate))).toMatchObject({ major: 16, source: "env" });
  });

  it("reads null when the image is not on this host", async () => {
    inspectImageMeta.mockResolvedValue(null);

    const reads = await readMajors([candidate]);
    expect(reads.get(candidateKey(candidate))).toBeNull();
  });
});

describe("withRecordedBaseline", () => {
  it("falls back to what the last deploy ran when the image is gone", () => {
    const merged = withRecordedBaseline([candidate], new Map([[candidateKey(candidate), null]]), {
      db: 16,
    });
    expect(merged.get(candidateKey(candidate))).toMatchObject({ major: 16 });
  });

  it("never overrides a major read off the image", () => {
    const read = { major: 17, source: "env" as const, raw: "17" };
    const merged = withRecordedBaseline([candidate], new Map([[candidateKey(candidate), read]]), {
      db: 16,
    });
    expect(merged.get(candidateKey(candidate))).toBe(read);
  });
});

describe("majorGateAfter", () => {
  it("blocks a deploy whose pull crossed a major", async () => {
    inspectImageMeta.mockResolvedValueOnce({ id: "sha256:a", env: pgEnv(16), labels: {} });
    const ctx = context();
    const state = await majorGateBefore(ctx, ["db"]);

    inspectImageMeta.mockResolvedValueOnce({ id: "sha256:b", env: pgEnv(18), labels: {} });
    await expect(majorGateAfter(ctx, state)).rejects.toBeInstanceOf(DeployBlockedError);

    expect(ctx.logLines.join(" ")).toContain("Stopped before the swap");
    expect(writeMajorGateBlock).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "app-1",
        services: [expect.objectContaining({ from: 16, to: 18, engine: "postgres" })],
      }),
    );
  });

  it("lets a deploy through when the major held", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: pgEnv(17), labels: {} });
    const ctx = context();

    await expect(majorGateAfter(ctx, await majorGateBefore(ctx, ["db"]))).resolves.toBeUndefined();
    expect(writeMajorGateBlock).not.toHaveBeenCalled();
  });

  it("lets a deploy through when it cannot read a major, and says so", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: [], labels: {} });
    const ctx = context();

    await expect(majorGateAfter(ctx, await majorGateBefore(ctx, ["db"]))).resolves.toBeUndefined();
    expect(ctx.logLines.join(" ")).toContain("Could not check the engine major");
    expect(writeMajorGateBlock).not.toHaveBeenCalled();
  });

  it("lets a first deploy through — nothing local to compare against", async () => {
    inspectImageMeta.mockResolvedValueOnce(null);
    const ctx = context();
    const state = await majorGateBefore(ctx, ["db"]);

    inspectImageMeta.mockResolvedValueOnce({ id: "sha256:b", env: pgEnv(18), labels: {} });
    await expect(majorGateAfter(ctx, state)).resolves.toBeUndefined();
    expect(writeMajorGateBlock).not.toHaveBeenCalled();
  });

  it("inspects nothing when no service is major-locked", async () => {
    const ctx = context({ web: { image: "nginx:latest" } });
    const state = await majorGateBefore(ctx, ["web"]);

    await majorGateAfter(ctx, state);
    expect(state.candidates).toEqual([]);
    expect(inspectImageMeta).not.toHaveBeenCalled();
  });
});

describe("gateCandidates", () => {
  it("reports a single-image app with no service name", () => {
    const ctx = context();
    (ctx.app as { deployType: string }).deployType = "image";

    expect(gateCandidates(ctx, ["db"])[0].service).toBeNull();
  });
});

describe("observedMajors", () => {
  it("records the major each major-locked service deployed on", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: pgEnv(17), labels: {} });

    expect(await observedMajors(context())).toEqual({ db: 17 });
  });

  it("records nothing it could not read", async () => {
    inspectImageMeta.mockResolvedValue({ id: "sha256:a", env: [], labels: {} });

    expect(await observedMajors(context())).toEqual({});
  });
});

describe("compareMajors", () => {
  it("pairs each candidate with its own reads", () => {
    const two = [candidate, { service: "docs", image: "mongo:latest", tag: "latest" }];
    const verdicts = compareMajors(
      two,
      new Map([
        [candidateKey(candidate), { major: 16, source: "env" as const, raw: "16" }],
        [candidateKey({ service: "docs", image: "mongo:latest" }), { major: 7, source: "env" as const, raw: "7" }],
      ]),
      new Map([
        [candidateKey(candidate), { major: 16, source: "env" as const, raw: "16" }],
        [candidateKey({ service: "docs", image: "mongo:latest" }), { major: 8, source: "env" as const, raw: "8" }],
      ]),
    );

    expect(verdicts.map((v) => v.kind)).toEqual(["ok", "changed"]);
  });
});

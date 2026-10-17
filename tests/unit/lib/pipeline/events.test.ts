import { describe, it, expect, vi, beforeEach } from "vitest";

// Pipeline events: one stream entry per publish, never a throw, and the deploy logger's stage and wait hooks.

const { redisMock } = vi.hoisted(() => ({
  redisMock: { xadd: vi.fn().mockResolvedValue("1-0") } as { xadd?: ReturnType<typeof vi.fn> },
}));
vi.mock("@/lib/redis", () => ({ redis: redisMock }));
vi.mock("@/lib/stream/producer", () => ({ addDeployLog: vi.fn().mockResolvedValue("1-0") }));
vi.mock("@/lib/stream/deploy-expiry", () => ({ expireDeployStream: vi.fn() }));
vi.mock("@/lib/deploy/waiting", () => ({ recordWait: vi.fn(), recordQueueTotal: vi.fn() }));
vi.mock("@/lib/deploy/running-clock", () => ({ pauseRunningClock: () => ({ resume: async () => {} }) }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  PIPELINE_STREAM,
  gateTokenDeployment,
  parsePipelineEntry,
  pipelineClaimed,
  pipelineFallback,
  pipelineSlot,
  publishPipeline,
} from "@/lib/pipeline/events";
import { createDeployLogger } from "@/lib/docker/deploy-logger";

const published = () =>
  (redisMock.xadd?.mock.calls ?? []).map((args) => {
    expect(args.slice(0, 5)).toEqual([PIPELINE_STREAM, "MAXLEN", "~", "1000", "*"]);
    expect(args[5]).toBe("e");
    return parsePipelineEntry({ e: args[6] as string });
  });

beforeEach(() => {
  redisMock.xadd = vi.fn().mockResolvedValue("1-0");
});

describe("publishPipeline", () => {
  it("adds one stamped entry to the pipeline stream", () => {
    publishPipeline({ kind: "queued", deploymentId: "d1" });
    const [entry] = published();
    expect(entry).toMatchObject({ kind: "queued", deploymentId: "d1" });
    expect(typeof entry?.at).toBe("number");
  });

  it("never throws when Redis is missing or rejects", async () => {
    redisMock.xadd = undefined;
    expect(() => publishPipeline({ kind: "queued", deploymentId: "d1" })).not.toThrow();
    redisMock.xadd = vi.fn().mockRejectedValue(new Error("down"));
    expect(() => publishPipeline({ kind: "queued", deploymentId: "d1" })).not.toThrow();
    await Promise.resolve();
  });
});

describe("gate publish points", () => {
  it("names the deployment behind a gate token, and none for a linked instance's build", () => {
    expect(gateTokenDeployment("dep123:ab12cd")).toBe("dep123");
    expect(gateTokenDeployment("build:x1y2z3")).toBeNull();
    expect(gateTokenDeployment("build:mesh-peer1-tok")).toBeNull();
  });

  it("says which builder a slot is on, here by default", () => {
    pipelineSlot("claim", "dep1:aa");
    pipelineSlot("release", "dep1:aa", "target-1");
    expect(published()).toEqual([
      expect.objectContaining({ kind: "slot", action: "claim", deploymentId: "dep1", builder: "local" }),
      expect.objectContaining({ kind: "slot", action: "release", deploymentId: "dep1", builder: "target-1" }),
    ]);
  });

  it("records a fallback with the target and its reason", () => {
    pipelineFallback("dep2:bb", { id: "t1", name: "Long House" }, "connection reset");
    expect(published()).toEqual([
      expect.objectContaining({ kind: "fallback", deploymentId: "dep2", builder: "t1", name: "Long House", reason: "connection reset" }),
    ]);
  });

  it("publishes each claimed deploy with the slot it took", () => {
    pipelineClaimed([{ id: "a" }, { id: "b", onTarget: true }]);
    expect(published()).toEqual([
      expect.objectContaining({ kind: "claimed", deploymentId: "a", slot: "local" }),
      expect.objectContaining({ kind: "claimed", deploymentId: "b", slot: "target" }),
    ]);
  });
});

describe("deploy logger hooks", () => {
  it("publishes every stage change and each wait as it starts or ends", async () => {
    const l = createDeployLogger("d9");
    l.stage("build", "running");
    await l.wait("build-slot");
    await l.wait("build-slot", { ahead: 1, total: 2 });
    await l.wait(null);
    l.stage("build", "success");
    expect(published().map((e) => (e?.kind === "stage" ? `${e.stage}:${e.status}` : e?.kind === "wait" ? `wait:${e.reason}` : e?.kind))).toEqual([
      "build:running",
      "wait:build-slot",
      "wait:null",
      "build:success",
    ]);
  });
});

describe("parsePipelineEntry", () => {
  it("rejects entries that aren't pipeline events", () => {
    expect(parsePipelineEntry({})).toBeNull();
    expect(parsePipelineEntry({ e: "not json" })).toBeNull();
    expect(parsePipelineEntry({ e: JSON.stringify({ kind: "queued" }) })).toBeNull();
  });
});

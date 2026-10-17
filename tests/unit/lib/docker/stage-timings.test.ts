import { describe, it, expect } from "vitest";
import { contextBytesFromBuildOutput, createStageTimings, exportMsFromBuildOutput, formatTimings, timedWait } from "@/lib/docker/stage-timings";

describe("contextBytesFromBuildOutput", () => {
  it("sums each step's last context size, in BuildKit's decimal units", () => {
    const out = [
      "#1 [internal] load build definition from Dockerfile",
      "#1 transferring dockerfile: 512B done",
      "#4 [internal] load build context",
      "#4 transferring context: 10.5MB 2.0s",
      "#4 transferring context: 12.30MB 2.4s done",
      "#9 [web internal] load build context",
      "#9 transferring context: 2.07kB done",
    ].join("\n");
    expect(contextBytesFromBuildOutput(out)).toBe(12_300_000 + 2070);
  });

  it("is null when no context was sent", () => {
    expect(contextBytesFromBuildOutput("#1 transferring dockerfile: 512B done")).toBeNull();
  });
});

describe("waits", () => {
  it("tallies waits apart from the phases and prints them", () => {
    const t = createStageTimings();
    t.waitBegin(1000);
    t.waitBegin(2000);
    t.waitEnd(61_000);
    t.waitEnd(70_000);
    t.range("build", 61_000, 101_000);
    expect(t.waited()).toBe(60_000);
    expect(t.snapshot()).toMatchObject({ waitMs: 60_000, build: { ms: 40_000 } });
    expect(formatTimings(t.snapshot())).toBe("[timing] build 40.0s, waited 60.0s");
  });

  it("opens on a reason and ends on null, passing each through", async () => {
    const t = createStageTimings();
    const seen: unknown[] = [];
    const wait = timedWait(t, (reason, place) => void seen.push([reason, place?.ahead]));
    await wait("build-slot", { ahead: 1 });
    expect(t.waited()).toBeGreaterThanOrEqual(0);
    await wait(null);
    const after = t.waited();
    await new Promise((r) => setTimeout(r, 15));
    expect(t.waited()).toBe(after);
    expect(seen).toEqual([["build-slot", 1], [null, undefined]]);
  });

  it("leaves waitMs off a run that never waited", () => {
    expect(createStageTimings().snapshot()).toEqual({});
  });
});

describe("createStageTimings", () => {
  it("times a begun and ended phase", () => {
    const t = createStageTimings();
    t.begin("clone", 1000);
    t.end("clone", 4200);
    expect(t.snapshot().clone).toMatchObject({ ms: 3200 });
  });

  it("sums a phase hit twice and keeps the first start", () => {
    const t = createStageTimings();
    t.range("pull", 0, 1000);
    t.range("pull", 5000, 7000);
    const pull = t.snapshot().pull!;
    expect(pull.ms).toBe(3000);
    expect(pull.startedAt).toBe(new Date(0).toISOString());
    expect(pull.endedAt).toBe(new Date(7000).toISOString());
  });

  it("records a span that throws", async () => {
    const t = createStageTimings();
    await expect(t.span("up", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(t.snapshot().up).toBeDefined();
  });

  it("closes phases a failure left open", () => {
    const t = createStageTimings();
    t.begin("healthWait", 0);
    t.endAll(2500);
    expect(t.snapshot().healthWait?.ms).toBe(2500);
  });

  it("formats phases in deploy order", () => {
    const t = createStageTimings();
    t.range("up", 0, 2000);
    t.range("clone", 0, 1500);
    expect(formatTimings(t.snapshot())).toBe("[timing] clone 1.5s, up 2.0s");
  });
});

describe("exportMsFromBuildOutput", () => {
  it("reads the docker-container driver's tarball export", () => {
    const out = [
      "#6 [2/2] RUN make",
      "#6 DONE 30.0s",
      "",
      "#7 exporting to docker image format",
      "#7 exporting layers 1.2s done",
      "#7 sending tarball 14.3s done",
      "#7 DONE 15.6s",
    ].join("\n");
    expect(exportMsFromBuildOutput(out)).toBe(15600);
  });

  it("reads the default driver's image export and ignores other steps", () => {
    const out = "#6 RUN x\n#6 DONE 0.2s\n#7 exporting to image\n#7 DONE 0.1s\n";
    expect(exportMsFromBuildOutput(out)).toBe(100);
  });

  it("is zero when nothing exported", () => {
    expect(exportMsFromBuildOutput("#1 DONE 1.0s")).toBe(0);
  });
});

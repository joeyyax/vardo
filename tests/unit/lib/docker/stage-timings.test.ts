import { describe, it, expect } from "vitest";
import { createStageTimings, exportMsFromBuildOutput, formatTimings } from "@/lib/docker/stage-timings";

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

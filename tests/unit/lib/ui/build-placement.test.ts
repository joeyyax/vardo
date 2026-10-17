import { describe, it, expect } from "vitest";
import { builtOn, buildStatsParts } from "@/lib/ui/build-placement";

// A build that ran elsewhere shows where and how its image came back; a local build shows nothing.

describe("builtOn", () => {
  it("shows nothing for a local build", () => {
    expect(builtOn({})).toBeNull();
    expect(builtOn({ buildTargetName: null, buildOutcome: null })).toBeNull();
    expect(builtOn({ buildTargetName: null, buildOutcome: "here", imageBytes: 1000 })).toBeNull();
  });

  it("names the target, with the registry pull and its time", () => {
    expect(builtOn({ buildTargetName: "Long House", buildOutcome: "target", imageTransfer: "registry", imageTransferMs: 2140 })).toEqual({
      kind: "target",
      target: "Long House",
      label: "Built on Long House",
      detail: "Pulled from the build registry in 2.1s",
    });
  });

  it("gives an SSH copy its size, and says when it skipped the registry", () => {
    const base = { buildTargetName: "Long House", buildOutcome: "target" as const, imageTransferMs: 14_000, imageTransferBytes: 412 * 1024 ** 2 };
    expect(builtOn({ ...base, imageTransfer: "ssh" })?.detail).toBe("Copied over SSH in 14s (412 MB)");
    expect(builtOn({ ...base, imageTransfer: "registry_skipped" })?.detail).toBe("Copied over SSH in 14s (412 MB), skipping the registry for a large layer");
    expect(builtOn({ ...base, imageTransfer: "mixed" })?.detail).toBe("Came back through the build registry and over SSH in 14s (412 MB)");
  });

  it("has no detail before the image came back", () => {
    expect(builtOn({ buildTargetName: "Long House", buildOutcome: "target" })?.detail).toBeNull();
  });

  it("says a fallback neutrally, with the target's reason as detail", () => {
    expect(builtOn({ buildTargetName: "Long House", buildOutcome: "fallback", buildFallbackReason: "it's unreachable" })).toEqual({
      kind: "fallback",
      target: "Long House",
      label: "Built here; Long House was unavailable",
      detail: "Long House couldn't build: it's unreachable",
    });
  });
});

describe("buildStatsParts", () => {
  const MB = 1024 ** 2;
  const stats = {
    builds: 12, fallbacks: 1, registry: 8, ssh: 3, skipped: 1, mixed: 0,
    medianBuildMs: 41_000, medianContextBytes: 12 * MB, medianImageBytes: 180 * MB, medianPeakBytes: null,
    medianTransferMs: 4200, medianTransferBytes: 400 * MB,
  };

  it("lists a target's counts, then its medians", () => {
    expect(buildStatsParts(stats, "target")).toEqual({
      counts: ["12 builds", "1 fell back here", "8 via registry", "3 over SSH (1 skipped the registry)"],
      medians: ["build 41s", "context 12 MB", "image 180 MB", "bring-back 4.2s", "400 MB over SSH"],
    });
  });

  it("words this server's fallbacks from its side, and shows its memory peak", () => {
    const local = { ...stats, registry: 0, ssh: 0, skipped: 0, medianTransferMs: null, medianTransferBytes: null, medianPeakBytes: 1.5 * 1024 ** 3 };
    expect(buildStatsParts(local, "here")).toEqual({
      counts: ["12 builds", "1 after a target was unavailable"],
      medians: ["build 41s", "context 12 MB", "image 180 MB", "peak memory 1.5 GB"],
    });
  });

  it("is null without builds", () => {
    expect(buildStatsParts(null, "here")).toBeNull();
    expect(buildStatsParts({ ...stats, builds: 0 }, "target")).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { isUncapturedSource, uncapturedReason } from "@/lib/backups/coverage";
import { buildBindPreflightScript, DIRECTORY_SOURCE_MARKER, EMPTY_SOURCE_MARKER } from "@/lib/backups/archive";

describe("bind mounts are opt-in", () => {
  const bind = (over: Record<string, unknown> = {}) => ({
    type: "bind" as const,
    backupStrategy: "tar",
    source: "/mnt/docker/gitea/data",
    ...over,
  });

  it("leaves an unclassified bind alone — this is where the media libraries live", () => {
    // /mnt/media is 18 TB. Capturing bind mounts by default would try to tar it.
    expect(isUncapturedSource(bind())).toBe(true);
    expect(isUncapturedSource(bind({ durability: "rebuildable" }))).toBe(true);
    expect(isUncapturedSource(bind({ durability: "external" }))).toBe(true);
  });

  it("captures a bind once somebody marks it stateful", () => {
    expect(isUncapturedSource(bind({ durability: "stateful" }))).toBe(false);
  });

  it("captures a bind that is dumped, whatever its durability", () => {
    // A bind-mounted Postgres: the dump does not care where the files live.
    expect(isUncapturedSource(bind({ backupStrategy: "dump" }))).toBe(false);
  });

  it("never calls a named volume uncaptured", () => {
    expect(isUncapturedSource({ type: "named", backupStrategy: "tar" })).toBe(false);
  });

  it("tells the operator how to opt in, and which path is affected", () => {
    expect(uncapturedReason(bind())).toMatch(/mark the volume stateful/);
    expect(uncapturedReason(bind())).toContain("/mnt/docker/gitea/data");
  });
});

describe("buildBindPreflightScript", () => {
  it("reports directory-ness and emptiness separately", () => {
    const script = buildBindPreflightScript();
    expect(script).toContain(DIRECTORY_SOURCE_MARKER);
    expect(script).toContain(EMPTY_SOURCE_MARKER);
  });

  it("only ever reads — nothing here can modify the host path", () => {
    const script = buildBindPreflightScript();
    expect(script).not.toMatch(/\b(rm|mv|mkdir|tar|touch|chown|chmod)\b/);
    // Redirects to a file would write; 2>/dev/null discards stderr and is fine.
    expect(script.replace(/2>\/dev\/null/g, "")).not.toContain(">");
  });

  it("takes the container-side path, never the host path", () => {
    // The host path belongs in the -v argv, which execFile passes without a
    // shell. Interpolating it here would reintroduce shell injection.
    expect(buildBindPreflightScript()).toContain('"/data"');
  });
});

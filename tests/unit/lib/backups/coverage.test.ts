import { describe, it, expect } from "vitest";
import { isUncapturedSource, pausedDumpReason, uncapturedReason, volumeCoverage } from "@/lib/backups/coverage";
import {
  buildBindPreflightScript,
  buildFileBackupScript,
  buildFileRestoreScript,
  DIRECTORY_SOURCE_MARKER,
  EMPTY_SOURCE_MARKER,
  FILE_PAYLOAD_NAME,
  FILE_SOURCE_MARKER,
} from "@/lib/backups/archive";

describe("bind mounts are opt-in", () => {
  const bind = (over: Record<string, unknown> = {}) => ({
    type: "bind" as const,
    backupStrategy: "tar",
    source: "/srv/app/data",
    ...over,
  });

  it("leaves an unclassified bind alone — this is where the media libraries live", () => {
    // Bind mounts are also where multi-terabyte media libraries live, so
    // capturing them by default would try to tar one.
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
    expect(uncapturedReason(bind())).toContain("/srv/app/data");
  });
});

describe("a dump needs a running container", () => {
  it("pauses a dump while its app is stopped", () => {
    expect(pausedDumpReason({ backupStrategy: "dump", appStatus: "stopped" })).toMatch(
      /needs a running container/,
    );
  });

  // The data is on disk either way, so tar keeps running. Only the dump waits.
  it("never pauses a tar — a stopped volume archives fine", () => {
    expect(pausedDumpReason({ backupStrategy: "tar", appStatus: "stopped" })).toBeNull();
  });

  it("never pauses a dump for a running app", () => {
    expect(pausedDumpReason({ backupStrategy: "dump", appStatus: "active" })).toBeNull();
  });

  // The system database is linked as a volume with no app behind it.
  it("never pauses a volume with no app", () => {
    expect(pausedDumpReason({ backupStrategy: "dump", appStatus: null })).toBeNull();
    expect(pausedDumpReason({ backupStrategy: "dump" })).toBeNull();
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

describe("single-file bind sources", () => {
  it("archives the file under a fixed name, not one derived from the host path", () => {
    // Nothing taken from a host path is interpolated into a shell script.
    const script = buildFileBackupScript();
    expect(script).toContain(FILE_PAYLOAD_NAME);
    expect(script).toContain("-C");
  });

  it("writes contents through the existing file rather than replacing it", () => {
    // The destination is a bind mount point; mv over it fails with EBUSY.
    const script = buildFileRestoreScript();
    expect(script).toMatch(/cat .* > /);
    expect(script).not.toMatch(/\bmv\b .*\/data/);
  });

  it("extracts before touching the destination, so a bad archive changes nothing", () => {
    const script = buildFileRestoreScript();
    expect(script.indexOf("tar xzf")).toBeLessThan(script.indexOf("cat "));
  });

  it("refuses an archive that does not hold exactly the expected payload", () => {
    expect(buildFileRestoreScript()).toMatch(/does not hold a single file/);
  });

  it("distinguishes file from directory, and empty from both", () => {
    const script = buildBindPreflightScript();
    expect(script).toContain(FILE_SOURCE_MARKER);
    expect(script).toContain(DIRECTORY_SOURCE_MARKER);
    // `ls -A` on a file errors, so emptiness is asked differently for each.
    expect(script).toContain("-s ");
  });
});

describe("volumeCoverage", () => {
  const vol = (over: Record<string, unknown> = {}) => ({
    type: "named" as const,
    backupStrategy: "tar",
    source: null,
    persistent: true,
    durability: null,
    backupSelection: null,
    ...over,
  });
  const scheduled = { direct: false, appReason: null, configReason: async () => null };

  it("covers a selected volume of a scheduled app", async () => {
    expect(await volumeCoverage(vol(), scheduled)).toEqual({ covered: true });
  });

  it("gives the durability reason even when a job links the volume itself", async () => {
    expect(await volumeCoverage(vol({ durability: "rebuildable" }), { ...scheduled, direct: true })).toEqual({
      covered: false,
      reason: "Rebuildable — reconstructed rather than restored",
    });
  });

  it("covers a volume its own job takes whatever the app says", async () => {
    expect(await volumeCoverage(vol(), { ...scheduled, direct: true, appReason: "Backups are off for the app" })).toEqual({ covered: true });
  });

  it("says a volume was switched off, and lists nothing for one that never persists", async () => {
    expect(await volumeCoverage(vol({ backupSelection: "exclude" }), scheduled)).toEqual({ covered: false, reason: "Switched off for this volume" });
    expect(await volumeCoverage(vol({ persistent: false }), scheduled)).toEqual({ covered: false, reason: null });
  });

  it("names the app's reason, and lists nothing for an app that's gone", async () => {
    expect(await volumeCoverage(vol(), { ...scheduled, appReason: "No backup job covers the app" })).toEqual({
      covered: false,
      reason: "No backup job covers the app",
    });
    expect(await volumeCoverage(vol(), { ...scheduled, appReason: undefined })).toEqual({ covered: false, reason: null });
  });

  it("says why a bind mount is left out", async () => {
    expect(await volumeCoverage(vol({ type: "bind", source: "/srv/x" }), scheduled)).toEqual({ covered: false, reason: "Bind mount, not opted in" });
    const config = { ...scheduled, configReason: async () => "Single config file" };
    expect(await volumeCoverage(vol({ type: "bind", source: "/srv/x", backupSelection: "include" }), config)).toEqual({
      covered: false,
      reason: "Single config file",
    });
  });
});

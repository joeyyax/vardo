import { describe, it, expect } from "vitest";
import { assessPreMigrationBackup } from "@/lib/backups/pre-migration";

const named = (persistent = true) => ({ type: "named" as const, persistent });
const bind = (persistent = true) => ({ type: "bind" as const, persistent });

describe("assessPreMigrationBackup", () => {
  it("reports a git-sourced app with no volumes as not worth backing up", () => {
    const result = assessPreMigrationBackup({ source: "git", volumes: [] });

    expect(result).toEqual({
      gitSourced: true,
      namedVolumes: 0,
      bindMounts: 0,
      worthBackingUp: false,
      needsManualCopy: false,
    });
  });

  it("reports a direct-source app as not git-sourced", () => {
    const result = assessPreMigrationBackup({ source: "direct", volumes: [named()] });

    expect(result.gitSourced).toBe(false);
    expect(result.worthBackingUp).toBe(true);
  });

  it("counts named volumes and bind mounts separately", () => {
    const result = assessPreMigrationBackup({
      source: "git",
      volumes: [named(), named(), bind()],
    });

    expect(result.namedVolumes).toBe(2);
    expect(result.bindMounts).toBe(1);
  });

  it("ignores non-persistent volumes", () => {
    const result = assessPreMigrationBackup({
      source: "git",
      volumes: [named(false), bind(false)],
    });

    expect(result.namedVolumes).toBe(0);
    expect(result.bindMounts).toBe(0);
    expect(result.worthBackingUp).toBe(false);
  });

  it("flags manual copy when any bind mount is present", () => {
    expect(
      assessPreMigrationBackup({ source: "git", volumes: [named(), bind()] }).needsManualCopy,
    ).toBe(true);
  });

  it("does not flag manual copy for named volumes only", () => {
    expect(
      assessPreMigrationBackup({ source: "git", volumes: [named()] }).needsManualCopy,
    ).toBe(false);
  });

  it("treats a bind-mount-only app as worth backing up but needing manual copy", () => {
    const result = assessPreMigrationBackup({ source: "direct", volumes: [bind()] });

    expect(result.worthBackingUp).toBe(true);
    expect(result.namedVolumes).toBe(0);
    expect(result.needsManualCopy).toBe(true);
  });
});

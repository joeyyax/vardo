import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Bind mount permission resolution — trusted org short-circuits per-project flag.
// This mirrors the logic in runDeployment (lib/docker/deploy.ts):
//
//   let projectAllowBindMounts = false;
//   if (orgTrusted) {
//     projectAllowBindMounts = true;
//   } else if (app.projectId) {
//     const project = await db.query.projects.findFirst({ ... });
//     projectAllowBindMounts = project?.allowBindMounts ?? false;
//   }
//
// runDeployment is DB-dependent and can't be unit tested directly.
// The resolution logic is extracted here as a pure function.
// ---------------------------------------------------------------------------

function resolveAllowBindMounts(
  orgTrusted: boolean,
  projectAllowBindMounts: boolean | null | undefined,
): boolean {
  if (orgTrusted) return true;
  return projectAllowBindMounts ?? false;
}

describe("resolveAllowBindMounts", () => {
  describe("trusted org", () => {
    it("returns true regardless of project flag", () => {
      expect(resolveAllowBindMounts(true, false)).toBe(true);
    });

    it("returns true even when project has allowBindMounts=false", () => {
      expect(resolveAllowBindMounts(true, false)).toBe(true);
    });

    it("returns true when project has allowBindMounts=true", () => {
      expect(resolveAllowBindMounts(true, true)).toBe(true);
    });

    it("returns true when project allowBindMounts is null (no project record)", () => {
      expect(resolveAllowBindMounts(true, null)).toBe(true);
    });

    it("returns true when project allowBindMounts is undefined (no projectId)", () => {
      expect(resolveAllowBindMounts(true, undefined)).toBe(true);
    });
  });

  describe("untrusted org", () => {
    it("returns false when project has allowBindMounts=false", () => {
      expect(resolveAllowBindMounts(false, false)).toBe(false);
    });

    it("returns true when project has allowBindMounts=true", () => {
      expect(resolveAllowBindMounts(false, true)).toBe(true);
    });

    it("returns false when project record is null (project not found)", () => {
      expect(resolveAllowBindMounts(false, null)).toBe(false);
    });

    it("returns false when app has no projectId (undefined)", () => {
      expect(resolveAllowBindMounts(false, undefined)).toBe(false);
    });
  });
});

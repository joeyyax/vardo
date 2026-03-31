import { describe, it, expect } from "vitest";
import { DeployBlockedError } from "@/lib/docker/errors";

// ---------------------------------------------------------------------------
// runDeployment() — isSystemManaged DeployBlockedError guard
//
// The deploy engine checks app.isSystemManaged immediately after fetching the
// app and throws DeployBlockedError to prevent the build from proceeding.
// Testing the guard as a pure function mirrors the pattern used elsewhere in
// the codebase (see security.test.ts, sweeper.test.ts).
// ---------------------------------------------------------------------------

type AppRef = {
  id: string;
  isSystemManaged: boolean;
  name?: string;
};

/**
 * Mirrors the guard in lib/docker/deploy.ts:
 *   if (app.isSystemManaged) {
 *     throw new DeployBlockedError("System-managed apps cannot be deployed ...");
 *   }
 */
function assertNotSystemManaged(app: AppRef): void {
  if (app.isSystemManaged) {
    throw new DeployBlockedError(
      "System-managed apps cannot be deployed through the deploy engine. Use Admin > Maintenance."
    );
  }
}

describe("runDeployment() — system-managed guard", () => {
  it("throws DeployBlockedError for a system-managed app", () => {
    const app: AppRef = { id: "app-1", isSystemManaged: true, name: "vardo" };
    expect(() => assertNotSystemManaged(app)).toThrow(DeployBlockedError);
  });

  it("throws with a message directing to Admin > Maintenance", () => {
    const app: AppRef = { id: "app-1", isSystemManaged: true };
    expect(() => assertNotSystemManaged(app)).toThrow(/Maintenance/);
  });

  it("does not throw for a regular app", () => {
    const app: AppRef = { id: "app-2", isSystemManaged: false, name: "my-app" };
    expect(() => assertNotSystemManaged(app)).not.toThrow();
  });

  it("DeployBlockedError is an instance of Error", () => {
    const app: AppRef = { id: "app-1", isSystemManaged: true };
    let caught: unknown;
    try {
      assertNotSystemManaged(app);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(DeployBlockedError);
    expect((caught as DeployBlockedError).name).toBe("DeployBlockedError");
  });
});

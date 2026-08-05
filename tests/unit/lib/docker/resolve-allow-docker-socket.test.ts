import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Docker socket permission resolution — mirrors runDeployment (lib/docker/deploy.ts).
// A local environment grants bind mounts but not the socket: creating one takes
// no admin role, so an implicit grant would bypass the project gate (#803).
// runDeployment is DB-dependent, so the resolution is extracted here.
// ---------------------------------------------------------------------------

function resolveAllowDockerSocket(input: {
  orgTrusted: boolean;
  projectAllowDockerSocket: boolean | null | undefined;
  envType: "production" | "staging" | "preview" | "local";
}): boolean {
  if (input.orgTrusted) return true;
  return input.projectAllowDockerSocket ?? false;
}

describe("resolveAllowDockerSocket", () => {
  it("grants the socket to a trusted org regardless of the project flag", () => {
    expect(
      resolveAllowDockerSocket({ orgTrusted: true, projectAllowDockerSocket: false, envType: "production" }),
    ).toBe(true);
  });

  it("refuses the socket in a local environment when the project flag is off", () => {
    expect(
      resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: false, envType: "local" }),
    ).toBe(false);
  });

  it("refuses the socket in a local environment when there is no project record", () => {
    expect(
      resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: null, envType: "local" }),
    ).toBe(false);
    expect(
      resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: undefined, envType: "local" }),
    ).toBe(false);
  });

  it("grants the socket in a local environment once the project flag is on", () => {
    expect(
      resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: true, envType: "local" }),
    ).toBe(true);
  });

  it("resolves the same way for every environment type", () => {
    const types = ["production", "staging", "preview", "local"] as const;
    for (const envType of types) {
      expect(resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: false, envType })).toBe(false);
      expect(resolveAllowDockerSocket({ orgTrusted: false, projectAllowDockerSocket: true, envType })).toBe(true);
    }
  });
});

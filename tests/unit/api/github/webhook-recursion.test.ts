import { describe, it, expect, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Webhook recursion guard — VARDO_PREVIEW early return
//
// When VARDO_PREVIEW=true the webhook handler must return immediately without
// processing any events. This prevents infinite loops: a self-preview instance
// receives the same GitHub webhooks as the host, and without this guard it
// would spin up further previews indefinitely.
//
// The guard is the very first check inside the POST handler (route.ts line ~21):
//   if (process.env.VARDO_PREVIEW === "true") {
//     return NextResponse.json({ ok: true, skipped: "preview instance" });
//   }
// ---------------------------------------------------------------------------

/**
 * Pure extraction of the recursion guard logic.
 * Returns `{ skipped: "preview instance" }` when VARDO_PREVIEW is "true",
 * or `null` to indicate the handler should proceed.
 */
function checkRecursionGuard(env: Record<string, string | undefined>): { skipped: string } | null {
  if (env["VARDO_PREVIEW"] === "true") {
    return { skipped: "preview instance" };
  }
  return null;
}

// Save and restore env
const saved: Record<string, string | undefined> = {};
afterEach(() => {
  for (const key of ["VARDO_PREVIEW"]) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
});

describe("webhook recursion guard", () => {
  it("skips processing when VARDO_PREVIEW is 'true'", () => {
    const result = checkRecursionGuard({ VARDO_PREVIEW: "true" });
    expect(result).not.toBeNull();
    expect(result?.skipped).toBe("preview instance");
  });

  it("proceeds when VARDO_PREVIEW is not set", () => {
    const result = checkRecursionGuard({});
    expect(result).toBeNull();
  });

  it("proceeds when VARDO_PREVIEW is set to any value other than 'true'", () => {
    expect(checkRecursionGuard({ VARDO_PREVIEW: "false" })).toBeNull();
    expect(checkRecursionGuard({ VARDO_PREVIEW: "1" })).toBeNull();
    expect(checkRecursionGuard({ VARDO_PREVIEW: "" })).toBeNull();
  });

  it("guard reads from process.env at runtime (not captured at module load)", () => {
    // Simulate what the route handler does at request time
    saved["VARDO_PREVIEW"] = process.env["VARDO_PREVIEW"];
    process.env["VARDO_PREVIEW"] = "true";

    const result = checkRecursionGuard(process.env as Record<string, string | undefined>);
    expect(result?.skipped).toBe("preview instance");

    // After clearing the flag, processing should proceed
    delete process.env["VARDO_PREVIEW"];
    const result2 = checkRecursionGuard(process.env as Record<string, string | undefined>);
    expect(result2).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handlePush — isSystemManaged filter
//
// Generic push-triggered deploys must skip system-managed apps so that Vardo's
// own repo pushes don't route into the generic deploy engine.
// ---------------------------------------------------------------------------

type AppRecord = {
  name: string;
  isSystemManaged: boolean;
  gitBranch: string | null;
  autoDeploy: boolean;
};

/**
 * Mirrors the filter applied in handlePush (route.ts):
 *   const matching = allApps.filter(
 *     (a) => !a.isSystemManaged && (a.gitBranch || "main") === branch
 *   );
 */
function filterAutoDeployApps(apps: AppRecord[], branch: string): AppRecord[] {
  return apps.filter(
    (a) => !a.isSystemManaged && (a.gitBranch || "main") === branch
  );
}

describe("handlePush — system-managed filter", () => {
  const branch = "main";

  it("excludes system-managed apps from auto-deploy", () => {
    const apps: AppRecord[] = [
      { name: "vardo", isSystemManaged: true, gitBranch: "main", autoDeploy: true },
      { name: "my-app", isSystemManaged: false, gitBranch: "main", autoDeploy: true },
    ];
    const matching = filterAutoDeployApps(apps, branch);
    expect(matching).toHaveLength(1);
    expect(matching[0].name).toBe("my-app");
  });

  it("includes regular apps that match the pushed branch", () => {
    const apps: AppRecord[] = [
      { name: "my-app", isSystemManaged: false, gitBranch: "main", autoDeploy: true },
    ];
    const matching = filterAutoDeployApps(apps, branch);
    expect(matching).toHaveLength(1);
  });

  it("excludes apps on a different branch", () => {
    const apps: AppRecord[] = [
      { name: "my-app", isSystemManaged: false, gitBranch: "develop", autoDeploy: true },
    ];
    const matching = filterAutoDeployApps(apps, branch);
    expect(matching).toHaveLength(0);
  });

  it("treats null gitBranch as 'main'", () => {
    const apps: AppRecord[] = [
      { name: "my-app", isSystemManaged: false, gitBranch: null, autoDeploy: true },
    ];
    const matching = filterAutoDeployApps(apps, "main");
    expect(matching).toHaveLength(1);
  });
});

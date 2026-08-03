import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdir, rm, readFile, writeFile } from "fs/promises";
import { join } from "path";

// PROJECTS_DIR is resolved when @/lib/paths loads, so the home override has to
// be in place before the imports below run.
const { HOME, findManyMock } = vi.hoisted(() => {
  const base = (process.env.TMPDIR || "/tmp").replace(/\/+$/, "");
  const home = `${base}/vardo-owner-test-${process.pid}`;
  process.env.VARDO_HOME_DIR = home;
  return { HOME: home, findManyMock: vi.fn() };
});

vi.mock("@/lib/db", () => ({ db: { query: { apps: { findMany: findManyMock } } } }));
vi.mock("@/lib/logger", () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
  assertAppDirOwnership,
  stampAppDirOwner,
  stampAllAppDirOwners,
  summarizeAppDirOwners,
  AppDirOwnershipError,
} from "@/lib/docker/app-dir-owner";
import { APP_OWNER_FILE, PROJECTS_DIR, appBaseDir, appOwnerFile } from "@/lib/paths";

const APPS = join(HOME, "apps");

async function makeAppDir(name: string): Promise<string> {
  const dir = appBaseDir(name);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function markOwner(name: string, appId: string): Promise<void> {
  await makeAppDir(name);
  await writeFile(appOwnerFile(name), JSON.stringify({ appId, appName: name }));
}

/** Apps in the database claiming a name. */
function claimedBy(...ids: string[]) {
  findManyMock.mockResolvedValue(ids.map((id) => ({ id })));
}

/** The app name in an `eq(apps.name, ...)` where clause. */
function nameFromWhere(where: unknown): string {
  const chunks = (where as { queryChunks?: { value?: unknown }[] })?.queryChunks ?? [];
  const param = chunks.find((c) => typeof c?.value === "string");
  return param ? String(param.value) : "";
}

/** Apps in the database claiming each name; names left out are claimed by nobody. */
function claimsByName(claims: Record<string, string[]>) {
  findManyMock.mockImplementation(async (args: { where: unknown }) =>
    (claims[nameFromWhere(args.where)] ?? []).map((id) => ({ id })),
  );
}

beforeEach(async () => {
  findManyMock.mockReset();
  claimedBy();
  await rm(APPS, { recursive: true, force: true });
  await mkdir(APPS, { recursive: true });
});

afterAll(async () => {
  await rm(HOME, { recursive: true, force: true });
});

describe("paths", () => {
  it("resolves PROJECTS_DIR under the overridden home", () => {
    expect(PROJECTS_DIR).toBe(APPS);
  });
});

describe("assertAppDirOwnership", () => {
  it("allows the app named by the marker", async () => {
    await markOwner("api", "app-1");
    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "api", operation: "stop" }),
    ).resolves.toBeUndefined();
  });

  it("refuses a foreign app that resolves to the same directory", async () => {
    await markOwner("api", "app-1");
    await expect(
      assertAppDirOwnership({ appId: "app-2", appName: "api", operation: "delete" }),
    ).rejects.toThrow(AppDirOwnershipError);
    await expect(
      assertAppDirOwnership({ appId: "app-2", appName: "api", operation: "delete" }),
    ).rejects.toThrow(/owned by app app-1/);
  });

  it("does not consult the database when a marker is present", async () => {
    await markOwner("api", "app-1");
    await assertAppDirOwnership({ appId: "app-1", appName: "api", operation: "stop" });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed marker rather than adopting it", async () => {
    await makeAppDir("api");
    await writeFile(appOwnerFile("api"), "{ not json");
    claimedBy("app-1");

    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "api", operation: "delete" }),
    ).rejects.toThrow(/could not be read/);
  });

  it("refuses a marker with no appId rather than adopting it", async () => {
    await makeAppDir("api");
    await writeFile(appOwnerFile("api"), JSON.stringify({ appName: "api" }));
    claimedBy("app-1");

    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "api", operation: "delete" }),
    ).rejects.toThrow(AppDirOwnershipError);
  });

  it("refuses an unreadable marker rather than adopting it", async () => {
    // A directory in the marker's place reads as EISDIR — an I/O failure that
    // must never be read as "no marker".
    await mkdir(join(appBaseDir("api"), APP_OWNER_FILE), { recursive: true });
    claimedBy("app-1");

    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "api", operation: "delete" }),
    ).rejects.toThrow(/could not be read/);
  });

  it("adopts a legacy directory when exactly one app claims the name", async () => {
    await makeAppDir("legacy");
    claimedBy("app-1");

    await assertAppDirOwnership({ appId: "app-1", appName: "legacy", operation: "delete" });

    const marker = JSON.parse(await readFile(appOwnerFile("legacy"), "utf8"));
    expect(marker.appId).toBe("app-1");
  });

  it("refuses a legacy directory when two apps claim the name", async () => {
    await makeAppDir("shared");
    claimedBy("app-1", "app-2");

    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "shared", operation: "delete" }),
    ).rejects.toThrow(/2 apps claim the name/);
    await expect(readFile(appOwnerFile("shared"), "utf8")).rejects.toThrow();
  });

  it("refuses a legacy directory when the sole claimant is another app", async () => {
    await makeAppDir("legacy");
    claimedBy("app-other");

    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "legacy", operation: "delete" }),
    ).rejects.toThrow(AppDirOwnershipError);
  });

  it("allows an app with no directory on disk", async () => {
    claimedBy("app-1");
    await expect(
      assertAppDirOwnership({ appId: "app-1", appName: "never-deployed", operation: "stop" }),
    ).resolves.toBeUndefined();
    await expect(readFile(appOwnerFile("never-deployed"), "utf8")).rejects.toThrow();
  });

  it("never blocks Vardo's own deploy, even against a foreign marker", async () => {
    await markOwner("vardo", "some-other-id");
    await expect(
      assertAppDirOwnership({ appId: "vardo-app-id", appName: "vardo", operation: "stop" }),
    ).resolves.toBeUndefined();
    expect(findManyMock).not.toHaveBeenCalled();
  });
});

describe("stampAppDirOwner", () => {
  it("stamps the base directory when creating a nested slot dir", async () => {
    await mkdir(join(appBaseDir("api"), "production", "blue"), { recursive: true });
    claimedBy("app-1");

    await stampAppDirOwner(join(appBaseDir("api"), "production", "blue"));

    const marker = JSON.parse(await readFile(appOwnerFile("api"), "utf8"));
    expect(marker.appId).toBe("app-1");
  });

  it("leaves an ambiguous name unmarked so the destructive guard refuses", async () => {
    await makeAppDir("shared");
    claimedBy("app-1", "app-2");

    await stampAppDirOwner(appBaseDir("shared"));

    await expect(readFile(appOwnerFile("shared"), "utf8")).rejects.toThrow();
  });

  it("does not overwrite an existing marker", async () => {
    await markOwner("api", "app-1");
    claimedBy("app-2");

    await stampAppDirOwner(appBaseDir("api"));

    const marker = JSON.parse(await readFile(appOwnerFile("api"), "utf8"));
    expect(marker.appId).toBe("app-1");
  });

  it("ignores paths outside the apps directory", async () => {
    claimedBy("app-1");
    await stampAppDirOwner("/tmp/somewhere-else");
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("skips Vardo's own directory", async () => {
    await makeAppDir("vardo");
    claimedBy("app-1");

    await stampAppDirOwner(appBaseDir("vardo"));

    await expect(readFile(appOwnerFile("vardo"), "utf8")).rejects.toThrow();
  });
});

describe("stampAllAppDirOwners", () => {
  async function ownerOf(name: string): Promise<string> {
    return JSON.parse(await readFile(appOwnerFile(name), "utf8")).appId;
  }

  it("stamps every directory and reports full coverage", async () => {
    await makeAppDir("api");
    await makeAppDir("web");
    await makeAppDir("worker");
    claimsByName({ api: ["app-1"], web: ["app-2"], worker: ["app-3"] });

    const report = await stampAllAppDirOwners();

    expect(report).toMatchObject({ total: 3, stamped: 3, alreadyOwned: 0, exempt: 0, gaps: [] });
    expect(await ownerOf("api")).toBe("app-1");
    expect(await ownerOf("web")).toBe("app-2");
    expect(await ownerOf("worker")).toBe("app-3");
  });

  it("names a directory with no app row as orphaned rather than failing the pass", async () => {
    await makeAppDir("api");
    await makeAppDir("abandoned");
    claimsByName({ api: ["app-1"] });

    const report = await stampAllAppDirOwners();

    expect(report.stamped).toBe(1);
    expect(report.gaps).toEqual([
      {
        appName: "abandoned",
        dir: appBaseDir("abandoned"),
        reason: "orphaned",
        detail: "no app in the database claims this name",
      },
    ]);
    await expect(readFile(appOwnerFile("abandoned"), "utf8")).rejects.toThrow();
  });

  it("names an unreadable marker without consulting the database for it", async () => {
    await makeAppDir("corrupt");
    await writeFile(appOwnerFile("corrupt"), "{ not json");
    claimsByName({ corrupt: ["app-1"] });

    const report = await stampAllAppDirOwners();

    expect(report.stamped).toBe(0);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({ appName: "corrupt", reason: "unreadable" });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("names a directory with two claimants as ambiguous and leaves it unmarked", async () => {
    await makeAppDir("shared");
    claimsByName({ shared: ["app-1", "app-2"] });

    const report = await stampAllAppDirOwners();

    expect(report.stamped).toBe(0);
    expect(report.gaps[0]).toMatchObject({ appName: "shared", reason: "ambiguous" });
    expect(report.gaps[0].detail).toContain("app-1, app-2");
    await expect(readFile(appOwnerFile("shared"), "utf8")).rejects.toThrow();
  });

  it("leaves an already-stamped directory alone", async () => {
    await markOwner("api", "app-1");
    claimsByName({ api: ["app-2"] });

    const report = await stampAllAppDirOwners();

    expect(report).toMatchObject({ total: 1, stamped: 0, alreadyOwned: 1, gaps: [] });
    expect(await ownerOf("api")).toBe("app-1");
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("counts Vardo's own directory as exempt, not failed", async () => {
    await makeAppDir("vardo");
    await makeAppDir("api");
    claimsByName({ vardo: ["app-vardo"], api: ["app-1"] });

    const report = await stampAllAppDirOwners();

    expect(report).toMatchObject({ total: 2, stamped: 1, exempt: 1, gaps: [] });
    await expect(readFile(appOwnerFile("vardo"), "utf8")).rejects.toThrow();
  });

  it("accounts for every directory it found", async () => {
    await makeAppDir("vardo");
    await markOwner("marked", "app-0");
    await makeAppDir("api");
    await makeAppDir("orphan");
    await makeAppDir("shared");
    claimsByName({ api: ["app-1"], shared: ["app-2", "app-3"] });

    const report = await stampAllAppDirOwners();

    expect(report.stamped + report.alreadyOwned + report.exempt + report.gaps.length).toBe(
      report.total,
    );
    expect(report.total).toBe(5);
  });

  it("writes nothing on a dry run but reports what it would stamp", async () => {
    await makeAppDir("api");
    await makeAppDir("orphan");
    claimsByName({ api: ["app-1"] });

    const report = await stampAllAppDirOwners({ dryRun: true });

    expect(report).toMatchObject({ total: 2, stamped: 1, dryRun: true });
    expect(report.gaps).toHaveLength(1);
    await expect(readFile(appOwnerFile("api"), "utf8")).rejects.toThrow();
  });

  it("reports nothing to do on a fresh install", async () => {
    await rm(APPS, { recursive: true, force: true });

    const report = await stampAllAppDirOwners();

    expect(report).toMatchObject({ total: 0, stamped: 0, gaps: [] });
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("ignores loose files in the apps directory", async () => {
    await makeAppDir("api");
    await writeFile(join(APPS, "README"), "not an app");
    claimsByName({ api: ["app-1"] });

    const report = await stampAllAppDirOwners();

    expect(report).toMatchObject({ total: 1, stamped: 1, gaps: [] });
  });

  it("is idempotent — a second pass stamps nothing new", async () => {
    await makeAppDir("api");
    claimsByName({ api: ["app-1"] });

    await stampAllAppDirOwners();
    const second = await stampAllAppDirOwners();

    expect(second).toMatchObject({ total: 1, stamped: 0, alreadyOwned: 1 });
  });

  it("summarizes coverage with the gate number", async () => {
    await makeAppDir("vardo");
    await markOwner("marked", "app-0");
    await makeAppDir("api");
    await makeAppDir("orphan");
    claimsByName({ api: ["app-1"] });

    const summary = summarizeAppDirOwners(await stampAllAppDirOwners());

    expect(summary).toBe(
      "2 of 4 app directories name an owner (1 stamped, 1 already marked); 1 exempt, 1 unresolved",
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm, readdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const { root } = vi.hoisted(() => ({ root: { dir: "" } }));

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/paths", async () => {
  const actual = await vi.importActual<typeof import("@/lib/paths")>("@/lib/paths");
  return {
    ...actual,
    appBaseDir: (name: string) => join(root.dir, name),
    readAppDirOwner: vi.fn().mockResolvedValue({ state: "missing" }),
    removeAppDirOwner: vi.fn().mockResolvedValue(undefined),
  };
});

import { matchAppVolumes, scanAppDir } from "@/lib/docker/app-data";
import { removeAppDir } from "@/lib/docker/app-dir-owner";

function vol(name: string, project?: string): { name: string; labels: Record<string, string>; mountpoint: string } {
  return { name, labels: project ? { "com.docker.compose.project": project } : {}, mountpoint: "" };
}

describe("matchAppVolumes", () => {
  const opts = { appName: "api", envNames: ["production", "pr-12"], otherAppNames: ["api", "api-v2"] };

  it("matches externalized volumes by name and compose volumes by project", () => {
    const names = matchAppVolumes(
      [
        vol("api-production_pgdata"),
        vol("api-pr-12_pgdata"),
        vol("api-production-shared_redis", "api-production-shared"),
        vol("a".repeat(64), "api-production-blue"),
      ],
      opts,
    );
    expect(names).toHaveLength(4);
  });

  it("leaves another app's volumes alone", () => {
    const names = matchAppVolumes(
      [
        vol("api-v2-production_pgdata"),
        vol("api-v2-production-shared_redis", "api-v2-production-shared"),
        vol("apiary-production_data"),
        vol("api-staging_data"),
        vol("unrelated_data", "unrelated"),
      ],
      opts,
    );
    expect(names).toEqual([]);
  });

  it("skips a pinned compose name another app owns", () => {
    const names = matchAppVolumes([vol("api-v2_db", "api-v2")], { ...opts, composeNames: ["api-v2"] });
    expect(names).toEqual([]);
  });
});

describe("bind-mounted data in the app directory", () => {
  let appDir: string;

  beforeEach(async () => {
    root.dir = await mkdtemp(join(tmpdir(), "vardo-app-data-"));
    appDir = join(root.dir, "api");
    const slot = join(appDir, "production", "blue");
    await mkdir(join(slot, "uploads"), { recursive: true });
    await mkdir(join(appDir, "repo", "data"), { recursive: true });
    await writeFile(join(appDir, "repo", "data", "db.sqlite"), "x");
    await writeFile(join(appDir, "repo", "README.md"), "x");
    await symlink(join(appDir, "repo", "data"), join(slot, "data"));
    await writeFile(join(slot, ".env"), "SECRET=1");
    await writeFile(
      join(slot, "docker-compose.yml"),
      [
        "services:",
        "  web:",
        "    image: nginx",
        "    volumes:",
        "      - ./uploads:/uploads",
        "      - ./data:/data",
        "      - /srv/elsewhere:/x",
        "      - pgdata:/var/lib/postgresql/data",
        "volumes:",
        "  pgdata: {}",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    await rm(root.dir, { recursive: true, force: true });
  });

  it("finds bind sources inside the app directory and the targets of linked ones", async () => {
    const { bindPaths } = await scanAppDir("api");
    expect(bindPaths).toEqual(
      [
        join(appDir, "production", "blue", "data"),
        join(appDir, "production", "blue", "uploads"),
        join(appDir, "repo", "data"),
      ].sort(),
    );
  });

  it("keeps those paths and removes the rest of the directory", async () => {
    const { bindPaths } = await scanAppDir("api");
    const result = await removeAppDir({ appId: "app-1", appName: "api", keep: bindPaths });

    expect(result.removed).toBe(false);
    expect(result.kept).toEqual(bindPaths);
    expect((await readdir(join(appDir, "repo"))).sort()).toEqual(["data"]);
    expect(await readdir(join(appDir, "repo", "data"))).toEqual(["db.sqlite"]);
    expect((await readdir(join(appDir, "production", "blue"))).sort()).toEqual(["data", "uploads"]);
  });

  it("removes everything when nothing is kept", async () => {
    const result = await removeAppDir({ appId: "app-1", appName: "api" });

    expect(result.removed).toBe(true);
    expect(await readdir(root.dir)).toEqual([]);
  });
});

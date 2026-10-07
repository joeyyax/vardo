// ---------------------------------------------------------------------------
// A shared service's relative paths resolve to one place from either slot, so
// its definition, and the config hash drift detection reads, stays put.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

vi.mock("@/lib/db", () => ({ db: {} }));

import { anchorSharedPaths } from "@/lib/docker/shared-paths";
import { anchorSharedServicePaths } from "@/lib/docker/deploy-steps/build";
import { parseCompose } from "@/lib/docker/compose-parse";
import type { DeployContext } from "@/lib/docker/deploy-context";

const userCompose = `
services:
  web:
    image: nginx
    volumes: ["./site:/usr/share/nginx/html"]
    env_file: [.env]
  proxy:
    image: caddy:2
    x-vardo-shared: true
    volumes:
      - ./conf:/conf:ro
      - ./cache:/cache
      - /srv/abs:/abs
      - named:/named
    env_file: [.env.shared, .env]
volumes:
  named:
`;

describe("anchorSharedPaths", () => {
  it("anchors repo entries in the repo and the rest in the shared dir", () => {
    const compose = parseCompose(userCompose);
    const anchored = anchorSharedPaths(compose, new Set(["proxy"]), {
      repoDir: "/apps/a/repo",
      repoEntries: new Set(["conf", ".env.shared"]),
      sharedDir: "/apps/a/production/shared",
    });

    expect(compose.services.proxy.volumes).toEqual([
      "/apps/a/repo/conf:/conf:ro",
      "/apps/a/production/shared/cache:/cache",
      "/srv/abs:/abs",
      "named:/named",
    ]);
    expect(compose.services.proxy.env_file).toEqual(["/apps/a/repo/.env.shared", "/apps/a/production/shared/.env"]);
    expect(compose.services.web.volumes).toEqual(["./site:/usr/share/nginx/html"]);
    expect(anchored.map((a) => a.inRepo)).toEqual([true, false, true, false]);
  });

  it("leaves a path that already climbs out of the slot alone", () => {
    const compose = parseCompose(`services:\n  p:\n    image: caddy\n    x-vardo-shared: true\n    volumes: ["../x:/x"]\n`);
    expect(anchorSharedPaths(compose, new Set(["p"]), { repoDir: null, repoEntries: new Set(), sharedDir: "/s" })).toEqual([]);
  });
});

describe("anchorSharedServicePaths", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vardo-shared-paths-"));
    await mkdir(join(root, "repo", "conf"), { recursive: true });
    await writeFile(join(root, "repo", ".env.shared"), "A=1\n");
    for (const slot of ["blue", "green"]) {
      await mkdir(join(root, "production", slot), { recursive: true });
      await symlink(join(root, "repo", "conf"), join(root, "production", slot, "conf"));
      await writeFile(join(root, "production", slot, ".env.shared"), "A=1\n");
      await writeFile(join(root, "production", slot, ".env"), "SECRET=x\n", { mode: 0o600 });
    }
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  const deployInto = async (slot: string) => {
    const ctx = {
      compose: parseCompose(userCompose),
      bareCompose: parseCompose(userCompose),
      repoDir: join(root, "repo"),
      appDir: join(root, "production"),
      slotDir: join(root, "production", slot),
      log: (line: string) => line,
    } as unknown as DeployContext;
    await anchorSharedServicePaths(ctx);
    return ctx;
  };

  it("renders the shared service identically for blue and green", async () => {
    const green = await deployInto("green");
    const blue = await deployInto("blue");

    expect(blue.bareCompose.services.proxy).toEqual(green.bareCompose.services.proxy);
    expect(blue.compose.services.proxy).toEqual(green.compose.services.proxy);
    expect(green.bareCompose.services.web.volumes).toEqual(["./site:/usr/share/nginx/html"]);
  });

  it("copies the slot's .env to the shared dir with its mode", async () => {
    await deployInto("green");
    const copy = join(root, "production", "shared", ".env");
    expect(await readFile(copy, "utf-8")).toBe("SECRET=x\n");
    expect((await stat(copy)).mode & 0o777).toBe(0o600);
  });

  it("records data still in a slot dir instead of recreating onto an empty one", async () => {
    await mkdir(join(root, "production", "blue", "cache"));
    const ctx = await deployInto("green");
    expect(ctx.sharedPathMoves).toEqual({
      proxy: [`${join(root, "production", "blue", "cache")} → ${join(root, "production", "shared", "cache")}`],
    });
  });

  it("records nothing once the shared dir holds the data", async () => {
    await mkdir(join(root, "production", "blue", "cache"));
    await mkdir(join(root, "production", "shared", "cache"), { recursive: true });
    expect((await deployInto("green")).sharedPathMoves).toBeUndefined();
  });
});

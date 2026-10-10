// Bind mounts that carry config checked out from git, such as a cron service's init SQL files
// and observability's Alloy, Grafana, Loki and Prometheus config beside their data.

import { execFileSync } from "child_process";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { configBindReason, fsProbe, repoPathOf, type BindProbe } from "@/lib/backups/bind-config";

const APPS = "/opt/vardo/apps";

/** Repo paths git tracks cleanly, and files on disk. */
function probe(clean: string[], files: string[] = []): BindProbe {
  return {
    isFile: async (path) => files.includes(path),
    cleanInGit: async (repo, rel) => clean.includes(`${repo}/${rel}`),
  };
}

const obs = `${APPS}/observability`;
const repoProbe = probe(
  [
    `${obs}/repo/etc/alloy/config.alloy`,
    `${obs}/repo/etc/dashboards`,
    `${obs}/repo/etc/grafana/provisioning`,
    `${APPS}/cron-service/repo/migrations/001_initial.sql`,
  ],
  [`${obs}/repo/etc/alloy/config.alloy`, `${APPS}/cron-service/repo/migrations/001_initial.sql`, `${APPS}/wiki/production/shared/app.db`],
);

describe("repoPathOf", () => {
  it("maps slot and repo paths onto the repo", () => {
    expect(repoPathOf(`${obs}/production/blue/etc/dashboards`, APPS)).toEqual({ repo: `${obs}/repo`, rel: "etc/dashboards" });
    expect(repoPathOf(`${obs}/repo/etc/dashboards`, APPS)).toEqual({ repo: `${obs}/repo`, rel: "etc/dashboards" });
    expect(repoPathOf(`${obs}/green/etc`, APPS)).toEqual({ repo: `${obs}/repo`, rel: "etc" });
  });

  it("leaves shared, slot roots and outside paths alone", () => {
    expect(repoPathOf(`${obs}/production/shared/loki`, APPS)).toBeNull();
    expect(repoPathOf(`${obs}/production/blue`, APPS)).toBeNull();
    expect(repoPathOf("/mnt/docker/gitea/data", APPS)).toBeNull();
  });
});

describe("configBindReason", () => {
  const reason = (source: string, p = repoProbe) => configBindReason(source, { projectsDir: APPS, probe: p });

  it("leaves out config the repo tracks, through a slot or the repo itself", async () => {
    expect(await reason(`${obs}/production/blue/etc/dashboards`)).toBe("Config from the app's repo");
    expect(await reason(`${obs}/production/green/etc/grafana/provisioning`)).toBe("Config from the app's repo");
    expect(await reason(`${obs}/repo/etc/alloy/config.alloy`)).toBe("Config from the app's repo");
    expect(await reason(`${APPS}/cron-service/production/blue/migrations/001_initial.sql`)).toBe("Config from the app's repo");
  });

  it("keeps a repo directory that holds files git doesn't track", async () => {
    expect(await reason(`${obs}/production/blue/data`)).toBeNull();
  });

  it("leaves out a single file under the apps directory, unless it holds data", async () => {
    const p = probe([], [`${obs}/production/shared/loki.yaml`, `${APPS}/wiki/production/shared/app.db`]);
    expect(await reason(`${obs}/production/shared/loki.yaml`, p)).toBe("Single config file");
    expect(await reason(`${APPS}/wiki/production/shared/app.db`, p)).toBeNull();
  });

  it("keeps data directories and anything outside the apps directory", async () => {
    expect(await reason(`${obs}/production/shared/prometheus`)).toBeNull();
    expect(await reason("/mnt/docker/gitea/data", probe([], ["/mnt/docker/gitea/data"]))).toBeNull();
    expect(await configBindReason(null)).toBeNull();
  });

  it("asks git whether a path is tracked and untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "bind-config-"));
    const repo = join(root, "app", "repo");
    await mkdir(join(repo, "etc"), { recursive: true });
    await mkdir(join(repo, "data"), { recursive: true });
    await writeFile(join(repo, "etc", "loki.yaml"), "auth_enabled: false\n");
    await writeFile(join(repo, "data", ".gitkeep"), "");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    await writeFile(join(repo, "data", "chunk-1"), "written at runtime");
    try {
      expect(await fsProbe.cleanInGit(repo, "etc")).toBe(true);
      expect(await fsProbe.cleanInGit(repo, "data")).toBe(false);
      expect(await fsProbe.cleanInGit(repo, "missing")).toBe(false);
      expect(await configBindReason(join(root, "app", "production", "blue", "etc"), { projectsDir: root })).toBe("Config from the app's repo");
      expect(await configBindReason(join(root, "app", "production", "blue", "data"), { projectsDir: root })).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the mount when git can't answer", async () => {
    const unknown: BindProbe = { isFile: async () => null, cleanInGit: async () => null };
    expect(await reason(`${obs}/production/blue/etc/dashboards`, unknown)).toBeNull();
  });
});

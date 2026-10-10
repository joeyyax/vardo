import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { repoFilePath } from "@/lib/docker/compose-root";
import { DeployBlockedError } from "@/lib/docker/errors";
import { readHostConfig } from "@/lib/config/host-config";
import { detectPreventiveFixes } from "@/lib/docker/compat";

let dir: string;
let repoDir: string;
let outside: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "vardo-repo-file-")));
  repoDir = join(dir, "repo");
  outside = join(dir, "console");
  await mkdir(join(repoDir, "web"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "secrets.env"), "ENCRYPTION_MASTER_KEY=abc\n");
  await writeFile(join(outside, "host.toml"), '[project]\nname = "leak"\n');
  await writeFile(join(outside, "package.json"), '{"dependencies":{"next":"12.0.0"}}');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("repoFilePath", () => {
  it("accepts files and in-repo symlinks", async () => {
    await writeFile(join(repoDir, "docker-compose.yml"), "services: {}\n");
    await symlink(join(repoDir, "docker-compose.yml"), join(repoDir, "web", "compose.yml"));
    expect(repoFilePath(repoDir, repoDir, "docker-compose.yml")).toBe(join(repoDir, "docker-compose.yml"));
    expect(repoFilePath(repoDir, join(repoDir, "web"), "compose.yml")).toBe(join(repoDir, "web", "compose.yml"));
    expect(repoFilePath(repoDir, repoDir, "missing.yml")).toBe(join(repoDir, "missing.yml"));
  });

  it("refuses a file symlinked outside the clone", async () => {
    await symlink(join(outside, "secrets.env"), join(repoDir, "docker-compose.yml"));
    expect(() => repoFilePath(repoDir, repoDir, "docker-compose.yml")).toThrow(DeployBlockedError);
    expect(() => repoFilePath(repoDir, repoDir, "docker-compose.yml")).toThrow(
      "docker-compose.yml points outside the repository",
    );
  });

  it("refuses a path through a symlinked directory", async () => {
    await symlink(outside, join(repoDir, "conf"));
    expect(() => repoFilePath(repoDir, repoDir, "conf/secrets.env")).toThrow(DeployBlockedError);
  });

  it("refuses a relative path that climbs out", () => {
    expect(() => repoFilePath(repoDir, repoDir, "../console/secrets.env")).toThrow(DeployBlockedError);
  });
});

describe("readHostConfig", () => {
  it("reads a host.toml in the repo", async () => {
    await writeFile(join(repoDir, "host.toml"), '[project]\nname = "api"\n');
    expect((await readHostConfig(repoDir))?.project?.name).toBe("api");
  });

  it("refuses a host.toml symlinked outside the repo", async () => {
    await symlink(join(outside, "host.toml"), join(repoDir, "host.toml"));
    await expect(readHostConfig(repoDir)).rejects.toThrow(DeployBlockedError);
  });
});

describe("detectPreventiveFixes", () => {
  it("ignores a package.json symlinked outside the repo", async () => {
    await symlink(join(outside, "package.json"), join(repoDir, "package.json"));
    expect(await detectPreventiveFixes(repoDir, repoDir)).toEqual([]);
  });

  it("reads a package.json in the repo", async () => {
    await writeFile(join(repoDir, "package.json"), '{"dependencies":{"next":"12.0.0"}}');
    expect((await detectPreventiveFixes(repoDir, repoDir)).map((f) => f.name)).toContain("openssl-legacy");
  });
});

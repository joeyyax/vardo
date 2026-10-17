import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  branchFetchArgs,
  buildSourcePaths,
  copyGitDir,
  dockerfileNeedsGit,
  dockerfilesIn,
  syncBuildSource,
  withBuildVarArgs,
  type BuildSpec,
} from "@/lib/docker/build-source";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commit(repo: string, files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      git(repo, "rm", "-q", path);
      continue;
    }
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
    git(repo, "add", path);
  }
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

let root: string;
let origin: string;
let checkout: string;
let mainV1: string;
let mainV2: string;
let featureTip: string;

const runner = (repo: string) => async (args: string[], env?: Record<string, string>) =>
  execFileSync("git", ["-C", repo, ...args], { env: { ...GIT_ENV, ...env }, stdio: "pipe" });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "build-source-"));
  origin = join(root, "origin");
  mkdirSync(origin);
  git(origin, "init", "-q", "-b", "main");
  mainV1 = commit(origin, { "a.txt": "a1", "b.txt": "b", "src/c.txt": "c", Dockerfile: "FROM scratch\nCOPY . .\n" }, "one");
  git(origin, "checkout", "-q", "-b", "feature");
  featureTip = commit(origin, { "feature.txt": "f" }, "feature");
  git(origin, "checkout", "-q", "main");
  mainV2 = commit(origin, { "a.txt": "a2", "b.txt": null, "n.txt": "n" }, "two");

  checkout = join(root, "checkout");
  execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", "main", `file://${origin}`, checkout], { env: GIT_ENV });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("branchFetchArgs", () => {
  it("names the branch's own remote ref and stays shallow", () => {
    expect(branchFetchArgs("feature/x")).toEqual([
      "fetch", "--depth", "1", "--", "origin", "+refs/heads/feature/x:refs/remotes/origin/feature/x",
    ]);
  });

  it("checks out another branch in a single-branch shallow clone, where a bare branch fetch can't", () => {
    git(checkout, "fetch", "-q", "--", "origin", "feature");
    expect(() => git(checkout, "reset", "--hard", "origin/feature", "--")).toThrow();

    git(checkout, ...branchFetchArgs("feature"));
    git(checkout, "reset", "-q", "--hard", "origin/feature", "--");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(featureTip);
    expect(git(checkout, "rev-parse", "--is-shallow-repository")).toBe("true");

    git(checkout, ...branchFetchArgs("main"));
    git(checkout, "reset", "-q", "--hard", "origin/main", "--");
    expect(git(checkout, "rev-parse", "HEAD")).toBe(mainV2);
  });
});

describe("syncBuildSource", () => {
  it("writes the commit's files without .git, then updates only what changed", async () => {
    const appDir = join(root, "env-sync");
    mkdirSync(appDir);
    git(checkout, ...branchFetchArgs("main"));
    git(checkout, "fetch", "-q", "--depth", "2", "origin", "main");
    const dir = await syncBuildSource({ git: runner(checkout), appDir, sha: mainV1 });

    expect(dir).toBe(buildSourcePaths(appDir).dir);
    expect(existsSync(join(dir, ".git"))).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a1");
    expect(existsSync(join(dir, "b.txt"))).toBe(true);
    const untouched = statSync(join(dir, "src/c.txt")).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    await syncBuildSource({ git: runner(checkout), appDir, sha: mainV2 });
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a2");
    expect(existsSync(join(dir, "b.txt"))).toBe(false);
    expect(readFileSync(join(dir, "n.txt"), "utf8")).toBe("n");
    expect(statSync(join(dir, "src/c.txt")).mtimeMs).toBe(untouched);
  });

  it("leaves the checkout's HEAD, index and files alone", async () => {
    const appDir = join(root, "env-isolated");
    mkdirSync(appDir);
    git(checkout, "reset", "-q", "--hard", mainV2);
    await syncBuildSource({ git: runner(checkout), appDir, sha: mainV1 });
    expect(git(checkout, "rev-parse", "HEAD")).toBe(mainV2);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(checkout, "a.txt"), "utf8")).toBe("a2");
  });

  it("starts over when its index is gone, dropping files no commit has", async () => {
    const appDir = join(root, "env-reset");
    mkdirSync(appDir);
    const dir = await syncBuildSource({ git: runner(checkout), appDir, sha: mainV2 });
    writeFileSync(join(dir, "stray.txt"), "x");
    rmSync(buildSourcePaths(appDir).index);
    await syncBuildSource({ git: runner(checkout), appDir, sha: mainV2 });
    expect(existsSync(join(dir, "stray.txt"))).toBe(false);
    expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a2");
  });

  it("copies .git at the deployed commit when asked, and drops it on the next sync", async () => {
    const appDir = join(root, "env-git");
    mkdirSync(appDir);
    git(checkout, "reset", "-q", "--hard", mainV2);
    const dir = await syncBuildSource({ git: runner(checkout), appDir, sha: mainV1 });
    await copyGitDir({ git: runner(checkout), repoDir: checkout, dir, sha: mainV1 });
    expect(git(dir, "rev-parse", "HEAD")).toBe(mainV1);
    expect(git(dir, "status", "--porcelain")).toBe("");

    await syncBuildSource({ git: runner(checkout), appDir, sha: mainV2 });
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});

describe("dockerfileNeedsGit", () => {
  it.each([
    "FROM node\nCOPY .git .git\n",
    "FROM node\nCOPY ./.git /app/.git\n",
    "FROM node\nADD .git/ /src/.git\n",
    "FROM node\nCOPY . .\nRUN git rev-parse HEAD > /sha\n",
    "FROM node\nRUN echo $(git describe --tags)\n",
    "FROM node\nRUN --mount=type=bind,source=.git,target=/src/.git git log -1\n",
  ])("detects %j", (content) => {
    expect(dockerfileNeedsGit(content)).toBe(true);
  });

  it.each([
    "FROM node\nCOPY . .\nRUN npm ci\n",
    "FROM node\nRUN apt-get install -y git\n",
    "FROM node\nCOPY .gitignore .\n",
    "FROM node\nRUN git clone https://example.com/x.git /x\n",
  ])("ignores %j", (content) => {
    expect(dockerfileNeedsGit(content)).toBe(false);
  });
});

describe("dockerfilesIn", () => {
  it("reads every compose service's Dockerfile, inline ones included, and nothing outside the tree", async () => {
    const dir = join(root, "compose-tree");
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(join(dir, "api/Dockerfile.prod"), "FROM api\n");
    writeFileSync(join(dir, "Dockerfile"), "FROM web\n");
    writeFileSync(
      join(dir, "compose.yml"),
      [
        "services:",
        "  web:",
        "    build: .",
        "  api:",
        "    build:",
        "      context: api",
        "      dockerfile: Dockerfile.prod",
        "  inline:",
        "    build:",
        "      context: .",
        "      dockerfile_inline: FROM inline",
        "  escape:",
        "    build: ../..",
        "  db:",
        "    image: postgres",
      ].join("\n"),
    );
    const found = await dockerfilesIn(dir, { dockerfilePath: null, composeFilePath: null, compose: true });
    expect(found.sort()).toEqual(["FROM api\n", "FROM inline", "FROM web\n"]);
  });

  it("falls back to the app's Dockerfile when there's no compose file", async () => {
    const dir = join(root, "dockerfile-tree");
    mkdirSync(dir);
    writeFileSync(join(dir, "Custom.Dockerfile"), "FROM x\n");
    expect(await dockerfilesIn(dir, { dockerfilePath: "Custom.Dockerfile", composeFilePath: null, compose: true })).toEqual(["FROM x\n"]);
  });
});

describe("withBuildVarArgs", () => {
  const vars = { VARDO_GIT_SHA: "abc", VARDO_GIT_BRANCH: "main" };

  it("adds each arg in each args form and keeps one the file sets", () => {
    const none: BuildSpec = { context: "." };
    withBuildVarArgs(none, vars);
    expect(none.args).toEqual(vars);

    const map: BuildSpec = { context: ".", args: { A: "1", VARDO_GIT_SHA: "mine" } };
    withBuildVarArgs(map, vars);
    expect(map.args).toEqual({ A: "1", VARDO_GIT_SHA: "mine", VARDO_GIT_BRANCH: "main" });

    const list: BuildSpec = { context: ".", args: ["A=1", "VARDO_GIT_BRANCH"] };
    withBuildVarArgs(list, vars);
    expect(list.args).toEqual(["A=1", "VARDO_GIT_BRANCH", "VARDO_GIT_SHA=abc"]);
  });

  it("leaves a build without vars alone", () => {
    const none: BuildSpec = { context: "." };
    withBuildVarArgs(none, {});
    expect(none.args).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  argsMap,
  buildKeysYaml,
  composeImageName,
  declaresGitShaArg,
  planComposeReuse,
  serviceBuildKey,
  unkeyableReason,
  writeBuildKeysFile,
  type ServiceKeyOpts,
} from "@/lib/docker/compose-build-reuse";

// Compose services are keyed one by one, so a commit that changes one service rebuilds only that one.

const SRC = "/srv/apps/shop/production/build-source";
const SHA = "a".repeat(40);

const trees: Record<string, string> = { web: "tree-web-1", api: "tree-api-1", site: "tree-site-1" };
const files: Record<string, string> = {
  [`${SRC}/web/Dockerfile`]: "FROM node:22\nCOPY . .\n",
  [`${SRC}/api/Dockerfile`]: "FROM node:22\nARG VARDO_GIT_SHA\nCOPY . .\n",
  [`${SRC}/site/Dockerfile`]: "FROM node:22\nARG NODE_ENV VARDO_GIT_BRANCH\nCOPY . .\n",
};

function opts(over: Partial<ServiceKeyOpts> = {}): ServiceKeyOpts {
  return {
    appId: "app-1",
    sourceDir: SRC,
    repoDir: "/srv/apps/shop/repo",
    gitSha: SHA,
    withGitDir: false,
    engineVersion: "29.4.0",
    git: async (args) => {
      const rel = args.at(-1)!.split(":")[1];
      if (!(rel in trees)) throw new Error("fatal: not a tree");
      return `${trees[rel]}\n`;
    },
    readFile: async (p) => {
      if (!(p in files)) throw new Error("ENOENT");
      return files[p];
    },
    ...over,
  };
}

const keyOf = async (build: Record<string, unknown>, o = opts()) => {
  const r = await serviceBuildKey(build, o);
  if (!("key" in r)) throw new Error(r.reason);
  return r.key;
};

beforeEach(() => {
  trees.web = "tree-web-1";
  trees.api = "tree-api-1";
});

describe("serviceBuildKey", () => {
  it("ignores VARDO_GIT_SHA when the Dockerfile doesn't declare it", async () => {
    const a = await keyOf({ context: `${SRC}/web`, args: { VARDO_GIT_SHA: "1".repeat(40) } });
    const b = await keyOf({ context: `${SRC}/web`, args: { VARDO_GIT_SHA: "2".repeat(40) } }, opts({ gitSha: "b".repeat(40) }));
    expect(a).toBe(b);
  });

  it("keys on VARDO_GIT_SHA when the Dockerfile declares it", async () => {
    const a = await keyOf({ context: `${SRC}/api`, args: { VARDO_GIT_SHA: "1".repeat(40) } });
    const b = await keyOf({ context: `${SRC}/api`, args: { VARDO_GIT_SHA: "2".repeat(40) } });
    expect(a).not.toBe(b);
  });

  it("keys on VARDO_GIT_BRANCH only when the Dockerfile declares it", async () => {
    const branch = (b: string) => ({ VARDO_GIT_SHA: SHA, VARDO_GIT_BRANCH: b });
    expect(await keyOf({ context: `${SRC}/web`, args: branch("main") })).toBe(await keyOf({ context: `${SRC}/web`, args: branch("pr-1") }));
    expect(await keyOf({ context: `${SRC}/site`, args: branch("main") })).not.toBe(await keyOf({ context: `${SRC}/site`, args: branch("pr-1") }));
  });

  it("changes with the context's tree, args, target and app", async () => {
    const base = { context: `${SRC}/web`, args: { NODE_ENV: "production" } };
    const key = await keyOf(base);
    expect(await keyOf({ ...base, args: { NODE_ENV: "development" } })).not.toBe(key);
    expect(await keyOf({ ...base, target: "prod" })).not.toBe(key);
    expect(await keyOf(base, opts({ appId: "app-2" }))).not.toBe(key);
    trees.web = "tree-web-2";
    expect(await keyOf(base)).not.toBe(key);
  });

  it("is stable across arg order and ignores its own label", async () => {
    const a = await keyOf({ context: `${SRC}/web`, args: { A: "1", B: "2" } });
    const b = await keyOf({ context: `${SRC}/web`, args: { B: "2", A: "1" }, labels: { "vardo.build.key": "old" } });
    expect(a).toBe(b);
  });

  it("keys on the commit when the context includes .git", async () => {
    const a = await keyOf({ context: `${SRC}/web` }, opts({ withGitDir: true }));
    const b = await keyOf({ context: `${SRC}/web` }, opts({ withGitDir: true, gitSha: "b".repeat(40) }));
    expect(a).not.toBe(b);
  });

  it("gives a reason instead of a key when inputs aren't all in the commit", async () => {
    expect(await serviceBuildKey({ context: `${SRC}/missing` }, opts())).toEqual({ reason: "its Dockerfile can't be read" });
    expect(await serviceBuildKey({ context: `${SRC}/web`, dockerfile_inline: "FROM x" }, opts({ git: async () => { throw new Error("x"); } })))
      .toEqual({ reason: "its context isn't in the commit" });
  });
});

describe("unkeyableReason", () => {
  it("refuses remote contexts, outside paths, extra contexts and secrets", () => {
    expect(unkeyableReason({ context: "https://example.com/repo.git" }, SRC)).toMatch(/local path/);
    expect(unkeyableReason({ context: "/etc" }, SRC)).toMatch(/outside/);
    expect(unkeyableReason({ context: `${SRC}/web`, additional_contexts: { x: "/tmp" } }, SRC)).toMatch(/additional/);
    expect(unkeyableReason({ context: `${SRC}/web`, secrets: ["npmrc"] }, SRC)).toMatch(/secrets/);
    expect(unkeyableReason({ context: SRC }, SRC)).toBeNull();
  });
});

describe("helpers", () => {
  it("reads list and map args", () => {
    expect(argsMap(["A=1", "B=x=y", "C"])).toEqual({ A: "1", B: "x=y" });
    expect(argsMap({ A: 1, B: null })).toEqual({ A: "1" });
  });

  it("finds ARG VARDO_GIT_SHA with or without a default", () => {
    expect(declaresGitShaArg("ARG VARDO_GIT_SHA\n")).toBe(true);
    expect(declaresGitShaArg("  arg VARDO_GIT_SHA=unknown\n")).toBe(true);
    expect(declaresGitShaArg("ARG VARDO_GIT_SHA_EXTRA\n")).toBe(false);
    expect(declaresGitShaArg("ARG CI VARDO_GIT_SHA NODE_ENV\n")).toBe(true);
  });

  it("names images as compose does", () => {
    expect(composeImageName("shop-production-blue", "web", undefined)).toBe("shop-production-blue-web");
    expect(composeImageName("shop-production-blue", "web", "shop-web:local")).toBe("shop-web:local");
  });

  it("labels keyed services in a compose override", async () => {
    expect(buildKeysYaml({ web: "k1" })).toContain("vardo.build.key: k1");
    const dir = await mkdtemp(join(tmpdir(), "keys-"));
    try {
      expect(await writeBuildKeysFile(dir, {})).toEqual([]);
      const args = await writeBuildKeysFile(dir, { web: "k1" });
      expect(args).toEqual(["-f", join(dir, "vardo-build-keys.yml")]);
      expect(await readFile(args[1], "utf-8")).toContain("k1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("planComposeReuse", () => {
  const config = {
    services: {
      web: { build: { context: `${SRC}/web` } },
      api: { build: { context: `${SRC}/api` }, image: "shop-api:local" },
      remote: { build: { context: "https://example.com/r.git" } },
    },
  };

  async function plan(found: Record<string, string>, rebuild = false) {
    const dir = await mkdtemp(join(tmpdir(), "reuse-"));
    const calls: string[][] = [];
    const docker = vi.fn(async (_cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "ls") {
        const key = args[args.indexOf("--filter") + 1].split("=").at(-1)!;
        return { stdout: found[key] ? `${found[key]}\n` : "" };
      }
      return { stdout: "" };
    });
    const log: string[] = [];
    try {
      const keys = {
        web: await keyOf(config.services.web.build),
        api: await keyOf(config.services.api.build),
      };
      const result = await planComposeReuse({
        ...opts(),
        services: ["web", "api", "remote"],
        config,
        project: "shop-production-green",
        workDir: dir,
        rebuild,
        docker,
        log: (l) => log.push(l),
      });
      return { result, calls, log, keys, dir };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("re-labels a matching image into this slot and builds the rest", async () => {
    const webKey = await keyOf(config.services.web.build);
    const { result, calls, log } = await plan({ [webKey]: "shop-production-blue-web:latest" });

    expect(result.build).toEqual(["api", "remote"]);
    expect(Object.keys(result.reused)).toEqual(["web"]);
    expect(Object.keys(result.keys)).toEqual(["web", "api"]);
    const relabel = calls.find((a) => a[0] === "build")!;
    expect(relabel).toEqual(expect.arrayContaining([
      "--label", "com.docker.compose.project=shop-production-green",
      "-t", "shop-production-green-web",
    ]));
    expect(log).toContain("[build] remote: no image reuse, its context isn't a local path");
  });

  it("skips lookups on a rebuild but still keys the services", async () => {
    const webKey = await keyOf(config.services.web.build);
    const { result, calls } = await plan({ [webKey]: "shop-production-blue-web:latest" }, true);

    expect(result.build).toEqual(["web", "api", "remote"]);
    expect(Object.keys(result.keys)).toEqual(["web", "api"]);
    expect(calls).toEqual([]);
  });

  it("pulls a key the host lacks from the build registry, re-labels it and drops the pulled tag", async () => {
    const webKey = await keyOf(config.services.web.build);
    const dir = await mkdtemp(join(tmpdir(), "reuse-"));
    const pulled: string[] = [];
    const untagged: string[] = [];
    const calls: string[][] = [];
    try {
      const result = await planComposeReuse({
        ...opts(),
        services: ["web", "api"],
        config,
        project: "shop-production-green",
        workDir: dir,
        rebuild: false,
        docker: async (_c, args) => {
          calls.push(args);
          return { stdout: "" };
        },
        log: () => {},
        registry: {
          appName: "shop",
          ops: {
            ref: (repo, key) => `localhost:5001/${repo}:${key}`,
            pull: async (ref) => {
              pulled.push(ref);
              return ref.endsWith(webKey);
            },
            untag: async (ref) => {
              untagged.push(ref);
            },
          },
        },
      });
      const ref = `localhost:5001/shop-web:${webKey}`;
      expect(result.build).toEqual(["api"]);
      expect(result.reused.web).toContain("from the build registry");
      expect(pulled).toHaveLength(2);
      expect(await readFile(join(dir, "vardo-reuse", "Dockerfile"), "utf-8")).toBe(`FROM ${ref}\n`);
      expect(calls.find((a) => a[0] === "build")).toEqual(expect.arrayContaining(["-t", "shop-production-green-web"]));
      expect(untagged).toEqual([ref]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds when the re-label fails", async () => {
    const webKey = await keyOf(config.services.web.build);
    const dir = await mkdtemp(join(tmpdir(), "reuse-"));
    try {
      const result = await planComposeReuse({
        ...opts(),
        services: ["web"],
        config,
        project: "p",
        workDir: dir,
        rebuild: false,
        docker: async (_c, args) => {
          if (args[0] === "build") throw new Error("pull access denied");
          return { stdout: args[0] === "image" ? `img-${webKey}:latest\n` : "" };
        },
        log: () => {},
      });
      expect(result.build).toEqual(["web"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

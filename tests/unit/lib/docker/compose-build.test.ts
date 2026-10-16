import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bakeArgs, bakeUsesSecrets, composeBuild, type ComposeBuildOpts } from "@/lib/docker/compose-build";

// A slot's compose build: reused services drop out, and the bounded builder's export goes through bake.

let root: string;
let calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[];
let answers: { print: string | null; images: string };

const bounded = (output: string | null) => ({
  env: { BUILDX_BUILDER: "vardo-bounded" },
  loadArgs: output ? ["--output", output] : ["--load"],
  output,
  limitBytes: 4 * 1024 ** 3,
});

const exec: ComposeBuildOpts["exec"] = async (cmd, args, opts) => {
  calls.push({ cmd, args, env: opts.env as NodeJS.ProcessEnv | undefined });
  if (cmd === "git") return { stdout: `tree-${args.at(-1)!.split(":")[1]}\n` };
  if (args.includes("config")) {
    return {
      stdout: JSON.stringify({
        services: {
          web: { build: { context: join(root, "src", "web") } },
          api: { build: { context: join(root, "src", "api") } },
        },
      }),
    };
  }
  if (args.includes("--print")) {
    if (answers.print === null) throw new Error("unknown flag: --print");
    return { stdout: answers.print };
  }
  if (args[0] === "image" && args[1] === "ls") return { stdout: answers.images };
  return { stdout: "#9 exporting to docker image format\n", stderr: "" };
};

function options(over: Partial<ComposeBuildOpts> = {}): ComposeBuildOpts {
  return {
    appId: "app-1",
    slotDir: join(root, "slot"),
    composeFileArgs: ["-f", "docker-compose.yml"],
    project: "shop-production-green",
    services: ["web", "api"],
    noCache: false,
    rebuild: false,
    bounded: bounded("type=docker,compression=uncompressed"),
    env: {} as NodeJS.ProcessEnv,
    sourceDir: join(root, "src"),
    repoDir: join(root, "repo"),
    gitSha: "a".repeat(40),
    withGitDir: false,
    log: () => {},
    exec,
    gate: (run) => run(),
    ...over,
  };
}

const BAKE = JSON.stringify({ group: { default: { targets: ["web", "api"] } }, target: { web: {}, api: {} } });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "compose-build-"));
  for (const svc of ["web", "api"]) {
    await mkdir(join(root, "src", svc), { recursive: true });
    await writeFile(join(root, "src", svc, "Dockerfile"), `FROM node:22\n# ${svc}\n`);
  }
  await mkdir(join(root, "slot"), { recursive: true });
  calls = [];
  answers = { print: BAKE, images: "" };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const bakeCall = () => calls.find((c) => c.args[0] === "buildx" && c.args[1] === "bake");
const composeBuildCall = () => calls.find((c) => c.args[0] === "compose" && c.args.includes("build") && !c.args.includes("--print"));

describe("composeBuild", () => {
  it("bakes compose's definition with the bounded export and the build-key labels", async () => {
    const out = await composeBuild(options());

    expect(out?.stdout).toContain("exporting to docker image format");
    const bake = bakeCall()!;
    expect(bake.args).toEqual(bakeArgs(join(root, "slot", "vardo-bake.json"), "type=docker,compression=uncompressed", []));
    expect(bake.env?.BUILDX_BUILDER).toBe("vardo-bounded");
    expect(bake.env?.BUILDX_BAKE_ENTITLEMENTS_FS).toBe("0");
    const print = calls.find((c) => c.args.includes("--print"))!;
    expect(print.args).toEqual(expect.arrayContaining(["-f", join(root, "slot", "vardo-build-keys.yml")]));
    expect(await readFile(join(root, "slot", "vardo-build-keys.yml"), "utf-8")).toMatch(/web:[\s\S]*vardo\.build\.key/);
  });

  it("skips the build when every service reused an image", async () => {
    answers.images = "shop-production-blue-web:latest\n";
    const lines: string[] = [];
    expect(await composeBuild(options({ log: (l) => lines.push(l) }))).toBeNull();
    expect(bakeCall()).toBeUndefined();
    expect(composeBuildCall()).toBeUndefined();
    expect(lines.some((l) => l.includes("web: reused"))).toBe(true);
  });

  it("names the remaining services when some were reused", async () => {
    let n = 0;
    const partial: ComposeBuildOpts["exec"] = async (cmd, args, opts) => {
      if (args[0] === "image" && args[1] === "ls") return { stdout: n++ === 0 ? "shop-production-blue-web:latest\n" : "" };
      return exec!(cmd, args, opts);
    };
    await composeBuild(options({ exec: partial }));
    expect(bakeCall()!.args.at(-1)).toBe("api");
    expect(calls.find((c) => c.args.includes("--print"))!.args.at(-1)).toBe("api");
  });

  it("falls back to compose build when compose can't print a bake file", async () => {
    answers.print = null;
    await composeBuild(options());
    expect(bakeCall()).toBeUndefined();
    expect(composeBuildCall()!.env?.BUILDX_BUILDER).toBe("vardo-bounded");
  });

  it("leaves builds with secrets to compose", async () => {
    answers.print = JSON.stringify({ target: { web: { secret: ["id=npmrc,env=NPMRC"] } } });
    await composeBuild(options());
    expect(bakeCall()).toBeUndefined();
    expect(composeBuildCall()).toBeDefined();
  });

  it("uses compose build with buildx's default export when the store is unknown", async () => {
    await composeBuild(options({ bounded: bounded(null) }));
    expect(calls.some((c) => c.args.includes("--print"))).toBe(false);
    expect(composeBuildCall()).toBeDefined();
  });

  it("passes --no-cache and skips reuse lookups on a no-cache rebuild", async () => {
    answers.images = "shop-production-blue-web:latest\n";
    await composeBuild(options({ noCache: true, rebuild: true }));
    expect(calls.some((c) => c.args[0] === "image")).toBe(false);
    expect(calls.find((c) => c.args.includes("--print"))!.args).toContain("--no-cache");
  });

  it("pushes each built keyed service to the build registry and nothing without one", async () => {
    const pushed: [string, string][] = [];
    const pushes: Promise<boolean>[] = [];
    const registry = {
      appName: "shop",
      ops: {
        ref: (repo: string, key: string) => `localhost:5001/${repo}:${key}`,
        pull: async () => false,
        push: async (local: string, ref: string) => {
          pushed.push([local, ref]);
          return true;
        },
        untag: async () => {},
      },
    };
    await composeBuild(options({ registry, pushes }));
    await Promise.all(pushes);

    expect(pushes).toHaveLength(2);
    expect(pushed.map(([local]) => local)).toEqual(["shop-production-green-web", "shop-production-green-api"]);
    expect(pushed[0][1]).toMatch(/^localhost:5001\/shop-web:[0-9a-f]{64}$/);

    calls = [];
    await composeBuild(options());
    expect(calls.some((c) => c.args[0] === "push" || c.args[0] === "tag")).toBe(false);
  });

  it("pushes only the services it built", async () => {
    let n = 0;
    const partial: ComposeBuildOpts["exec"] = async (cmd, args, opts) => {
      if (args[0] === "image" && args[1] === "ls") return { stdout: n++ === 0 ? "shop-production-blue-web:latest\n" : "" };
      return exec!(cmd, args, opts);
    };
    const pushed: string[] = [];
    const registry = {
      appName: "shop",
      ops: { ref: (r: string, k: string) => `${r}:${k}`, pull: async () => false, push: async (l: string) => (pushed.push(l), true), untag: async () => {} },
    };
    await composeBuild(options({ exec: partial, registry, pushes: [] }));
    expect(pushed).toEqual(["shop-production-green-api"]);
  });

  it("builds everything, without keys, from a checkout with no commit", async () => {
    await composeBuild(options({ gitSha: undefined }));
    expect(calls.some((c) => c.args.includes("config"))).toBe(false);
    expect(calls.find((c) => c.args.includes("--print"))!.args).not.toContain(join(root, "slot", "vardo-build-keys.yml"));
  });
});

describe("bakeUsesSecrets", () => {
  it("spots a target with secrets", () => {
    expect(bakeUsesSecrets({ target: { a: {}, b: { secret: ["id=x"] } } })).toBe(true);
    expect(bakeUsesSecrets({ target: { a: { secret: [] } } })).toBe(false);
    expect(bakeUsesSecrets(null)).toBe(false);
  });
});

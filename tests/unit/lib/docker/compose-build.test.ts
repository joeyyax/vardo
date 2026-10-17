import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bakeArgs, bakeUsesSecrets, composeBuild, type ComposeBuildOpts } from "@/lib/docker/compose-build";

const { copies } = vi.hoisted(() => ({ copies: { ran: [] as string[], saveFails: false } }));
// `docker save` there and `docker load` here, as shell stand-ins.
vi.mock("child_process", async (orig) => {
  const real = await orig<typeof import("child_process")>();
  return {
    ...real,
    spawn: (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: ("ignore" | "pipe")[]; detached: boolean }) => {
      copies.ran.push(`${opts.env.DOCKER_HOST ? "there" : "here"} ${args.join(" ")}`);
      const script = args[0] === "save" ? (copies.saveFails ? "echo 'ssh: connect to host 10.99.0.2 port 2222: Connection refused' >&2; exit 255" : "head -c 1024 /dev/zero") : "cat >/dev/null";
      return real.spawn("sh", ["-c", script], { stdio: opts.stdio, detached: opts.detached });
    },
  };
});

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
  copies.ran = [];
  copies.saveFails = false;
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

  it("pushes nothing from a build here, with a build registry set", async () => {
    const pushed: string[] = [];
    // `push` is what the old ops had; a build here must not reach for it.
    const ops = { ref: (r: string, k: string) => `localhost:5001/${r}:${k}`, pull: async () => false, untag: async () => {}, push: async (l: string) => (pushed.push(l), true) };
    // `pushes` is the old collector; swap passed it on every deploy.
    await composeBuild(options({ registry: { appName: "shop", ops }, pushes: [] } as Partial<ComposeBuildOpts>));
    expect(pushed).toEqual([]);
    expect(calls.some((c) => c.args[0] === "push" || c.args[0] === "tag")).toBe(false);
  });

  it("logs this server's builder only when it builds here", async () => {
    const notes = ["[build] Building in vardo-buildkit (memory limit 4 GiB)"];
    const here: string[] = [];
    await composeBuild(options({ bounded: { ...bounded(null), notes }, log: (l) => here.push(l) }));
    expect(here).toContain(notes[0]);
  });

  describe("on a build target", () => {
    const target = {
      id: "lh", kind: "ssh" as const, name: "Long House", host: "10.99.0.2", port: 2222, user: "vardo",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----", hostKey: "[10.99.0.2]:2222 ssh-ed25519 AAAA", maxConcurrent: 1,
    };
    const registry = {
      appName: "shop",
      ops: { ref: (r: string, k: string) => `localhost:5001/${r}:${k.slice(0, 6)}`, pull: async () => false, untag: async () => {} },
    };

    it("builds there with compose build, pushes from there and pulls each image here", async () => {
      await composeBuild(options({ registry, targets: [target], gate: (run) => run({ target }) }));
      const remote = (c: (typeof calls)[number]) => c.env?.DOCKER_HOST === "ssh://vardo@10.99.0.2:2222";
      expect(bakeCall()).toBeUndefined();
      const build = calls.find((c) => c.args.includes("build") && c.args[0] === "compose" && !c.args.includes("--print"))!;
      expect(remote(build)).toBe(true);
      expect(build.env?.BUILDX_BUILDER).toBeUndefined();
      const push = calls.filter((c) => c.args[0] === "push");
      const pull = calls.filter((c) => c.args[0] === "pull");
      expect(push.map((c) => c.args.at(-1))).toEqual([expect.stringMatching(/^localhost:5001\/shop-web:/), expect.stringMatching(/^localhost:5001\/shop-api:/)]);
      expect(push.every(remote)).toBe(true);
      expect(pull.some(remote)).toBe(false);
      expect(calls.some((c) => !remote(c) && c.args[0] === "tag" && c.args[2] === "shop-production-green-web")).toBe(true);
    });

    it("leaves this server's builder out of the log", async () => {
      const lines: string[] = [];
      const notes = ["[build] Building in vardo-buildkit (memory limit 4 GiB)"];
      await composeBuild(options({ bounded: { ...bounded(null), notes }, registry, targets: [target], gate: (run) => run({ target }), log: (l) => lines.push(l) }));
      expect(lines).not.toContain(notes[0]);
    });

    it("builds there and copies a service with no key over SSH", async () => {
      const keyless: ComposeBuildOpts["exec"] = async (cmd, args, opts) =>
        cmd === "git" && args.at(-1)!.endsWith(":api") ? Promise.reject(new Error("not in tree")) : exec!(cmd, args, opts);
      const lines: string[] = [];
      await composeBuild(options({ exec: keyless, registry, targets: [target], gate: (run) => run({ target }), log: (l) => lines.push(l) }));
      expect(bakeCall()).toBeUndefined();
      expect(calls.filter((c) => c.args[0] === "push").map((c) => c.args.at(-1))).toEqual([expect.stringMatching(/^localhost:5001\/shop-web:/)]);
      expect(copies.ran).toEqual(["there save shop-production-green-api", "here load --quiet"]);
      expect(lines).toContain("[build] Copying shop-production-green-api from Long House over SSH");
    });

    it("builds there with no build registry and copies each image over SSH", async () => {
      const lines: string[] = [];
      await composeBuild(options({ registry: null, targets: [target], gate: (run) => run({ target }), log: (l) => lines.push(l) }));
      expect(calls.some((c) => c.args[0] === "push" || c.args[0] === "pull")).toBe(false);
      expect(copies.ran).toEqual([
        "there save shop-production-green-web", "here load --quiet",
        "there save shop-production-green-api", "here load --quiet",
      ]);
      expect(calls.at(-1)).toMatchObject({ args: ["image", "rm", "shop-production-green-web", "shop-production-green-api"], env: { DOCKER_HOST: "ssh://vardo@10.99.0.2:2222" } });
      expect(lines.filter((l) => l.startsWith("[build] Copied"))).toEqual([
        expect.stringMatching(/^\[build\] Copied shop-production-green-web from Long House over SSH \(1 KB, \d+\.\ds\)$/),
        expect.stringMatching(/^\[build\] Copied shop-production-green-api from Long House over SSH \(1 KB, \d+\.\ds\)$/),
      ]);
    });

    it("falls back to SSH when the push from the target fails", async () => {
      const failing: ComposeBuildOpts["exec"] = async (cmd, args, opts) =>
        args[0] === "push" ? Promise.reject(Object.assign(new Error("push failed"), { stderr: "dial tcp: connection refused" })) : exec!(cmd, args, opts);
      const lines: string[] = [];
      await composeBuild(options({ exec: failing, registry, targets: [target], gate: (run) => run({ target }), log: (l) => lines.push(l) }));
      expect(lines.filter((l) => l.startsWith("[build] Couldn't use the build registry"))).toHaveLength(1);
      expect(copies.ran.filter((r) => r.startsWith("there save"))).toEqual(["there save shop-production-green-web", "there save shop-production-green-api"]);
      expect(lines).toContain("[build] Registry unavailable; copying shop-production-green-web from Long House over SSH");
    });

    it("turns a failed push and a failed copy into a builder failure", async () => {
      copies.saveFails = true;
      const failing: ComposeBuildOpts["exec"] = async (cmd, args, opts) =>
        args[0] === "push" ? Promise.reject(Object.assign(new Error("push failed"), { stderr: "dial tcp: connection refused" })) : exec!(cmd, args, opts);
      const { BuilderError } = await import("@/lib/docker/build-targets");
      await expect(composeBuild(options({ exec: failing, registry, targets: [target], gate: (run) => run({ target }) })))
        .rejects.toBeInstanceOf(BuilderError);
    });
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

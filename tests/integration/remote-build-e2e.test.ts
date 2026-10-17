// A real remote build: the gate overflows to a Docker host over SSH, which builds, pushes to the registry, and this host pulls.
// Runs only with VARDO_E2E_TARGET set to "user@host:port", VARDO_E2E_TARGET_KEY to a private key file
// and VARDO_E2E_REGISTRY to a registry both hosts reach by that name. Needs Redis at REDIS_URL or localhost:7200.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";

vi.mock("@/lib/logger", async () => (await import("@/tests/helpers/mocks")).loggerModule());
vi.mock("@/lib/db", () => ({ db: { select: () => { throw new Error("no database in this test"); } } }));
vi.mock("@/lib/system-settings", () => ({ getSystemSettingRaw: async () => null, setSystemSetting: async () => {} }));

const spec = process.env.VARDO_E2E_TARGET?.match(/^([^@]+)@(.+):(\d+)$/);
const registryHost = process.env.VARDO_E2E_REGISTRY;
const enabled = Boolean(spec && registryHost && process.env.VARDO_E2E_TARGET_KEY);

const { withBuildSlot, redisBuildStore, resetBuildGateForTests } = await import("@/lib/docker/build-gate");
const { redis } = await import("@/lib/redis");
const prefix = `test:remote-build:${process.pid}:${Date.now()}`;
const gateKeys = Object.fromEntries(
  ["queue", "seen", "running", "hold", "admits", "started", "remote", "target"].map((k) => [k, `${prefix}:${k}${k === "target" ? ":" : ""}`]),
) as Parameters<typeof redisBuildStore>[0];
const { hostKeyFingerprints, onTarget, remoteEnv, scanHostKey, targetDockerVersion, resetTargetHealth } = await import("@/lib/docker/build-targets");
const { bringBack, TARGET_BUILD } = await import("@/lib/docker/remote-build");
const { composeBuild } = await import("@/lib/docker/compose-build");
const { registryOps, parseRegistryUrl } = await import("@/lib/docker/build-registry");
const { dockerEnv } = await import("@/lib/docker/docker-env");

const run = (args: string[], env: NodeJS.ProcessEnv = dockerEnv(), cwd?: string) =>
  execFileAsync("docker", args, { env, cwd, timeout: 300_000 }).then((r) => String(r.stdout).trim());
const exists = (image: string, env?: NodeJS.ProcessEnv) => run(["image", "inspect", "--format", "{{.Id}}", image], env).then(() => true, () => false);

describe.skipIf(!enabled)("remote build over SSH", () => {
  const tag = `e2e${Date.now().toString(36)}`;
  const lines: string[] = [];
  const log = (line: string) => void lines.push(line);
  let dir: string;
  let target: Parameters<typeof onTarget>[0];
  const local: string[] = [];

  beforeAll(async () => {
    resetBuildGateForTests(redisBuildStore(gateKeys));
    dir = await mkdtemp(join(tmpdir(), "vardo-e2e-"));
    const [, user, host, port] = spec!;
    target = {
      id: "e2e", kind: "ssh", name: "e2e builder", host, port: Number(port), user,
      privateKey: await readFile(process.env.VARDO_E2E_TARGET_KEY!, "utf-8"),
      hostKey: await scanHostKey(host, Number(port)),
      maxConcurrent: 1,
    };
  });

  afterAll(async () => {
    for (const image of local) await run(["image", "rm", "-f", image]).catch(() => {});
    await rm(dir, { recursive: true, force: true });
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    redis.disconnect();
  });

  it("reaches the target's daemon through the pinned host key", async () => {
    const version = await targetDockerVersion(target);
    expect(version).toMatch(/^\d+\.\d+/);
    log(`[e2e] target Docker ${version}`);
    await expect(targetDockerVersion({ ...target, hostKey: target.hostKey!.replace(/AAAA\S+/g, "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl") }))
      .rejects.toMatchObject({ reason: "its SSH host key doesn't match the pinned one" });
    await expect(targetDockerVersion({ ...target, port: 1 })).rejects.toMatchObject({ reason: "it's unreachable" });
    expect(await hostKeyFingerprints(target.hostKey!)).toContainEqual(expect.stringMatching(/^SHA256:\S+ \(ED25519\)$/));
  });

  it("overflows a Dockerfile build to the target when this host is busy, then pulls the image here", async () => {
    const src = join(dir, "web");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Dockerfile"), `FROM busybox:1.36\nRUN echo ${tag} > /built\nLABEL vardo.e2e=${tag}\n`);
    const image = `vardo-e2e-web:${tag}`;
    const ref = `${registryHost}/vardo-e2e-web:${tag}`;
    local.push(image);
    expect(await exists(image)).toBe(false);

    // Holds this host's only slot.
    let releaseLocal!: () => void;
    const held = withBuildSlot({ log: () => {} }, { env: {}, loadArgs: [], limitBytes: null }, () => new Promise<void>((r) => (releaseLocal = r)));
    await new Promise((r) => setTimeout(r, 200));

    const placed: (string | null)[] = [];
    await withBuildSlot({ log, deploymentId: `e2e-${tag}`, targets: [target] }, { env: {}, loadArgs: [], limitBytes: null }, async ({ target: on }) => {
      placed.push(on?.id ?? null);
      if (!on) throw new Error("expected the target");
      await onTarget(on, async (session) => {
        await run(["build", ...TARGET_BUILD.loadArgs, "--progress=plain", "-t", image, src], remoteEnv(dockerEnv(), session), src);
        expect(await exists(image, remoteEnv(dockerEnv(), session))).toBe(true);
        expect(await exists(image)).toBe(false);
        await bringBack([{ image, ref }], { authEnv: dockerEnv(), session, log });
        expect(await exists(image, remoteEnv(dockerEnv(), session))).toBe(false);
      });
    });
    releaseLocal();
    await held;

    expect(placed).toEqual(["e2e"]);
    expect(await run(["image", "inspect", "--format", "{{index .Config.Labels \"vardo.e2e\"}}", image])).toBe(tag);
    expect(await run(["run", "--rm", image, "cat", "/built"])).toBe(tag);
    expect(await exists(ref)).toBe(false);
    log(`[e2e] ${lines.filter((l) => l.startsWith("[build]")).join(" | ")}`);
    console.log(lines.join("\n"));
  }, 300_000);

  it("builds a keyed compose app on the target and brings each service image here", async () => {
    const repo = join(dir, "repo");
    await mkdir(join(repo, "api"), { recursive: true });
    await writeFile(join(repo, "api", "Dockerfile"), `FROM busybox:1.36\nRUN echo api-${tag} > /built\n`);
    const git = (args: string[]) => execFileAsync("git", ["-C", repo, ...args]).then((r) => String(r.stdout).trim());
    await execFileAsync("git", ["init", "-q", repo]);
    await git(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "add", "."]);
    await git(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "e2e"]);
    const sha = await git(["rev-parse", "HEAD"]);
    const slot = join(dir, "slot");
    await mkdir(slot, { recursive: true });
    await writeFile(join(slot, "docker-compose.yml"), `services:\n  api:\n    build:\n      context: ${join(repo, "api")}\n`);
    const project = `vardo-e2e-${tag}`;
    local.push(`${project}-api`);

    const ops = registryOps({ ...parseRegistryUrl(registryHost!)!, credential: null }, { log, withAuth: (fn) => fn(dockerEnv()) });
    const pushes: Promise<boolean>[] = [];
    const before = lines.length;
    await composeBuild({
      appId: `e2e-${tag}`, slotDir: slot, composeFileArgs: ["-f", join(slot, "docker-compose.yml")], project, services: ["api"],
      noCache: false, rebuild: false, bounded: { env: {}, loadArgs: [], limitBytes: null }, env: dockerEnv(),
      sourceDir: repo, repoDir: repo, gitSha: sha, withGitDir: false, log,
      registry: { ops, appName: project }, pushes, targets: [target],
      gate: (fn) => fn({ target }),
    });
    expect(pushes).toHaveLength(0);
    expect(await run(["run", "--rm", `${project}-api`, "cat", "/built"])).toBe(`api-${tag}`);
    console.log(lines.slice(before).filter((l) => !l.startsWith("[e2e]")).join("\n"));
  }, 300_000);

  it("falls back to this host when the target can't push to the registry", async () => {
    if (!process.env.VARDO_E2E_BREAK_PUSH) return;
    resetTargetHealth();
    const src = join(dir, "fallback");
    await mkdir(src, { recursive: true });
    await writeFile(join(src, "Dockerfile"), `FROM busybox:1.36\nRUN echo fallback-${tag} > /built\n`);
    const image = `vardo-e2e-fallback:${tag}`;
    local.push(image);
    let releaseLocal!: () => void;
    const held = withBuildSlot({ log: () => {} }, { env: {}, loadArgs: [], limitBytes: null }, () => new Promise<void>((r) => (releaseLocal = r)));
    await new Promise((r) => setTimeout(r, 200));
    const placed: (string | null)[] = [];
    const before = lines.length;
    const build = withBuildSlot({ log, targets: [target] }, { env: {}, loadArgs: [], limitBytes: null }, async ({ target: on }) => {
      placed.push(on?.id ?? null);
      if (!on) return void (await run(["build", "-q", "-t", image, src], dockerEnv(), src));
      await onTarget(on, async (session) => {
        await run(["build", "-q", "-t", image, src], remoteEnv(dockerEnv(), session), src);
        await bringBack([{ image, ref: `${registryHost}/vardo-e2e-fallback:${tag}` }], { authEnv: dockerEnv(), session, log });
      });
    });
    // The local slot frees once the target has failed, so the retry can take it.
    while (placed.length === 0) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 3000));
    releaseLocal();
    await held;
    await build;
    expect(placed).toEqual(["e2e", null]);
    expect(await run(["run", "--rm", image, "cat", "/built"])).toBe(`fallback-${tag}`);
    console.log(lines.slice(before).join("\n"));
  }, 300_000);
});

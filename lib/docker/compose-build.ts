// `docker compose build` for a slot, with per-service image reuse and the bounded builder's export.

import { writeFile } from "fs/promises";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";
import { COMPOSE_BUILD_UP_TIMEOUT, COMPOSE_QUERY_TIMEOUT, GIT_METADATA_TIMEOUT } from "./constants";
import { engineVersion } from "./engine-version";
import { composeImageName, planComposeReuse, writeBuildKeysFile } from "./compose-build-reuse";
import { serviceRepo, type RegistryOps } from "./build-registry";
import type { BoundedBuild } from "./build-memory";
import type { WaitWriter } from "./deploy-logger";
import { withBuildSlot, type BuildPlacement } from "./build-gate";
import { onTarget, remoteEnv, type BuildTarget } from "./build-targets";
import { TARGET_BUILD, bringBack } from "./remote-build";

/** Bake file compose's own build would run, written into the slot. */
export const BAKE_FILE = "vardo-bake.json";

const MAX_BUFFER = 10 * 1024 * 1024;

type Output = { stdout: string; stderr: string };
type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

export type ComposeBuildOpts = {
  appId: string;
  slotDir: string;
  composeFileArgs: string[];
  project: string;
  services: string[];
  noCache: boolean;
  /** Skips image reuse. */
  rebuild: boolean;
  bounded: BoundedBuild;
  /** Registry auth env. */
  env: NodeJS.ProcessEnv;
  /** Build tree and checkout; reuse needs both and the commit. */
  sourceDir?: string;
  repoDir?: string | null;
  gitSha?: string;
  withGitDir: boolean;
  log: (line: string) => void;
  signal?: AbortSignal;
  exec?: Exec;
  /** Records the build's memory peak against this deploy and pauses its sweeper clock while it waits. */
  deploymentId?: string;
  /** Opens a `build-slot` wait while the build queues for the builder. */
  wait?: WaitWriter;
  /** Holds a builder slot for the build itself, after image reuse is settled. Defaults to the build gate. */
  gate?: <T>(run: (placement?: BuildPlacement) => Promise<T>) => Promise<T>;
  /** Targets the build may run on when every service to build has a known image name. */
  targets?: BuildTarget[];
  /** Build registry: keyed images are pulled from it for reuse; only builds on a target push to it. */
  registry?: { ops: RegistryOps; appName: string } | null;
};

/** Bake targets that use build secrets, which compose resolves itself. */
export function bakeUsesSecrets(bake: unknown): boolean {
  const targets = (bake as { target?: Record<string, { secret?: unknown[] }> })?.target ?? {};
  return Object.values(targets).some((t) => Array.isArray(t?.secret) && t.secret.length > 0);
}

/** `docker buildx bake` flags that export like a bounded `docker build`. */
export function bakeArgs(file: string, output: string, services: string[]): string[] {
  return [
    "buildx", "bake", "-f", file, "--progress=plain",
    "--set", `*.output=${output}`, "--provenance=false", "--sbom=false", ...services,
  ];
}

/** Builds the slot's services; returns the build output, or null when every service reused an image. */
export async function composeBuild(opts: ComposeBuildOpts): Promise<Output | null> {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  const { slotDir, project, log } = opts;

  let services = opts.services;
  let keyFileArgs: string[] = [];
  let keys: Record<string, string> = {};
  const images: Record<string, string> = {};
  if (opts.sourceDir && opts.repoDir && opts.gitSha) {
    try {
      const { stdout } = await exec(
        "docker",
        ["compose", ...opts.composeFileArgs, "-p", project, "config", "--format", "json"],
        { env: dockerEnv(), cwd: slotDir, timeout: COMPOSE_QUERY_TIMEOUT * 3, maxBuffer: MAX_BUFFER },
      );
      const repoDir = opts.repoDir;
      const config = JSON.parse(String(stdout)) as { services?: Record<string, { image?: string }> };
      for (const name of services) images[name] = composeImageName(project, name, config.services?.[name]?.image);
      const plan = await planComposeReuse({
        appId: opts.appId,
        sourceDir: opts.sourceDir,
        repoDir,
        gitSha: opts.gitSha,
        withGitDir: opts.withGitDir,
        engineVersion: await engineVersion("dockerfile"),
        git: async (args) =>
          String((await exec("git", ["-C", repoDir, ...args], { timeout: GIT_METADATA_TIMEOUT })).stdout),
        services,
        config,
        project,
        workDir: slotDir,
        rebuild: opts.rebuild,
        docker: (cmd, args) => exec(cmd, args, { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT * 6 }),
        log,
        registry: opts.registry,
      });
      for (const line of Object.values(plan.reused)) log(line);
      services = plan.build;
      keys = plan.keys;
      keyFileArgs = await writeBuildKeysFile(slotDir, plan.keys);
    } catch (err) {
      log(`[build] Couldn't check for reusable images, building every service: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      services = opts.services;
      keys = {};
      keyFileArgs = [];
    }
  }
  if (services.length === 0) return null;
  const registry = opts.registry;
  // Images come back by name, so every service built remotely needs one; a keyed one can come through the registry.
  const remote = services.every((name) => images[name])
    ? services.map((name) => ({
        image: images[name],
        ref: registry && keys[name] ? registry.ops.ref(serviceRepo(registry.appName, name), keys[name]) : null,
      }))
    : null;
  const targets = remote ? (opts.targets ?? []) : [];
  const gate = opts.gate ?? ((run) =>
    withBuildSlot({ deploymentId: opts.deploymentId, log, wait: opts.wait, signal: opts.signal, targets }, opts.bounded, run));
  return gate(async (placement) => {
    const target = placement?.target;
    if (!target || !remote) return runComposeBuild(opts, exec, services, keyFileArgs, opts.bounded, opts.env);
    return onTarget(target, async (session) => {
      const built = await runComposeBuild(opts, exec, services, keyFileArgs, TARGET_BUILD, remoteEnv(opts.env, session));
      await bringBack(remote, { authEnv: opts.env, session, from: target.name, log, signal: opts.signal, exec });
      return built;
    });
  });
}

async function runComposeBuild(
  opts: ComposeBuildOpts,
  exec: Exec,
  services: string[],
  keyFileArgs: string[],
  bounded: BoundedBuild,
  baseEnv: NodeJS.ProcessEnv,
): Promise<Output> {
  const { slotDir, project } = opts;
  const files = [...opts.composeFileArgs, ...keyFileArgs];
  const env = { ...baseEnv, ...bounded.env };
  const run = { cwd: slotDir, timeout: COMPOSE_BUILD_UP_TIMEOUT, maxBuffer: MAX_BUFFER, signal: opts.signal };
  const noCache = opts.noCache ? ["--no-cache"] : [];
  const reused = services.length < opts.services.length;
  // Name services only when some were reused; a bare build also builds what `up` would.
  const named = reused ? services : [];

  if (bounded.output) {
    const bake = await printBake(exec, files, project, noCache, named, { ...run, env });
    if (bake) {
      const file = join(slotDir, BAKE_FILE);
      await writeFile(file, bake);
      // Compose grants read access to every build context; bake would ask for each.
      return asOutput(await exec("docker", bakeArgs(file, bounded.output, named), { ...run, env: { ...env, BUILDX_BAKE_ENTITLEMENTS_FS: "0" } }));
    }
  }
  return asOutput(
    await exec("docker", ["compose", "--progress=plain", ...files, "-p", project, "build", ...noCache, ...named], { ...run, env }),
  );
}

/** Compose's bake definition, or null when this compose can't print one or it needs secrets. */
async function printBake(
  exec: Exec,
  files: string[],
  project: string,
  noCache: string[],
  services: string[],
  run: Record<string, unknown> & { env: NodeJS.ProcessEnv },
): Promise<string | null> {
  try {
    const { stdout } = await exec(
      "docker",
      ["compose", ...files, "-p", project, "build", "--print", ...noCache, ...services],
      { ...run, env: run.env, timeout: COMPOSE_QUERY_TIMEOUT * 3 },
    );
    const text = String(stdout);
    const bake = JSON.parse(text);
    if (!bake?.target || bakeUsesSecrets(bake)) return null;
    return text;
  } catch {
    return null;
  }
}

function asOutput(r: { stdout: string | Buffer; stderr?: string | Buffer }): Output {
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

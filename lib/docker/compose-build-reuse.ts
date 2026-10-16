// Per-service image reuse for compose builds: a service whose build inputs match an earlier image skips its build.

import { createHash } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { isAbsolute, join, relative, resolve } from "path";
import { stringify } from "yaml";
import { BUILD_CONFIG_VERSION, BUILD_KEY_LABEL, GIT_SHA_ARG, buildArgsHash } from "./build-key";
import { serviceRepo, type RegistryOps } from "./build-registry";

/** Compose file that labels each built image with its key; passed to `compose build` only. */
export const BUILD_KEYS_FILE = "vardo-build-keys.yml";

/** Slot subdirectory holding the re-label Dockerfile. */
const RELABEL_DIR = "vardo-reuse";

type Exec = (cmd: string, args: string[], opts?: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

type BuildSpec = Record<string, unknown> & { context?: string; dockerfile?: string; dockerfile_inline?: string };

export type ServiceKeyInput = {
  appId: string;
  /** Git tree id of the build context at the deployed commit. */
  contextTree: string;
  /** SHA-256 of the Dockerfile, or of the inline Dockerfile. */
  dockerfileHash: string;
  args: Record<string, string>;
  /** The resolved build spec minus context, dockerfile and args. */
  rest: Record<string, unknown>;
  engineVersion: string;
  /** Commit when the context includes .git, whose contents change every commit. */
  gitSha: string | null;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** JSON with sorted keys, so equal specs hash equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function composeServiceBuildKey(input: ServiceKeyInput): string {
  return sha256(
    JSON.stringify([
      BUILD_CONFIG_VERSION,
      "compose",
      input.appId,
      input.contextTree,
      input.dockerfileHash,
      buildArgsHash(input.args),
      stableJson(input.rest),
      input.engineVersion,
      input.gitSha,
    ]),
  );
}

/** Build args as a map; `KEY` without a value is dropped, as compose does when the env lacks it. */
export function argsMap(args: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(args)) {
    for (const a of args.map(String)) {
      const i = a.indexOf("=");
      if (i > 0) out[a.slice(0, i)] = a.slice(i + 1);
    }
  } else if (args && typeof args === "object") {
    for (const [k, v] of Object.entries(args)) if (v !== null && v !== undefined) out[k] = String(v);
  }
  return out;
}

/** Whether a Dockerfile declares `ARG VARDO_GIT_SHA`; undeclared, the arg can't change the image. */
export function declaresGitShaArg(dockerfile: string): boolean {
  return new RegExp(`^\\s*ARG\\s+${GIT_SHA_ARG}(?:\\s|=|$)`, "im").test(dockerfile);
}

/** Why a service can't be keyed, or null. Remote contexts, extra contexts and secrets carry inputs outside the commit. */
export function unkeyableReason(build: BuildSpec, sourceDir: string): string | null {
  const context = build.context;
  if (typeof context !== "string" || !isAbsolute(context)) return "its context isn't a local path";
  const rel = relative(sourceDir, context);
  if (rel.startsWith("..") || isAbsolute(rel)) return "its context is outside the repository";
  if (build.additional_contexts && Object.keys(build.additional_contexts).length > 0) return "it has additional contexts";
  if (build.secrets && Object.keys(build.secrets).length > 0) return "it uses build secrets";
  return null;
}

/** Image name compose gives a built service: its `image`, else `<project>-<service>`. */
export function composeImageName(project: string, service: string, image: unknown): string {
  return typeof image === "string" && image ? image : `${project}-${service}`;
}

export type ServiceKeyOpts = {
  appId: string;
  /** Build tree (or checkout) the contexts point into. */
  sourceDir: string;
  /** Checkout holding the commit's objects. */
  repoDir: string;
  gitSha: string;
  withGitDir: boolean;
  engineVersion: string;
  git: (args: string[]) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
};

/** A service's key, or a reason it has none. */
export async function serviceBuildKey(
  build: BuildSpec,
  opts: ServiceKeyOpts,
): Promise<{ key: string } | { reason: string }> {
  const reason = unkeyableReason(build, opts.sourceDir);
  if (reason) return { reason };
  const read = opts.readFile ?? ((p: string) => readFile(p, "utf-8"));
  const context = build.context as string;
  const rel = relative(opts.sourceDir, context).split("\\").join("/");

  let dockerfile: string;
  if (typeof build.dockerfile_inline === "string") {
    dockerfile = build.dockerfile_inline;
  } else {
    try {
      dockerfile = await read(resolve(context, build.dockerfile || "Dockerfile"));
    } catch {
      return { reason: "its Dockerfile can't be read" };
    }
  }

  let contextTree: string;
  try {
    contextTree = (await opts.git(["rev-parse", "--verify", `${opts.gitSha}:${rel}`])).trim();
  } catch {
    return { reason: "its context isn't in the commit" };
  }
  if (!contextTree) return { reason: "its context isn't in the commit" };

  const args = argsMap(build.args);
  if (!declaresGitShaArg(dockerfile)) delete args[GIT_SHA_ARG];
  const rest = { ...build };
  for (const k of ["context", "dockerfile", "dockerfile_inline", "args", "labels"]) delete rest[k];
  rest.labels = Object.fromEntries(
    Object.entries((build.labels as Record<string, unknown>) ?? {}).filter(([k]) => k !== BUILD_KEY_LABEL),
  );

  return {
    key: composeServiceBuildKey({
      appId: opts.appId,
      contextTree,
      dockerfileHash: sha256(dockerfile),
      args,
      rest,
      engineVersion: opts.engineVersion,
      gitSha: opts.withGitDir ? opts.gitSha : null,
    }),
  };
}

export type ComposeReusePlan = {
  /** Services still to build. */
  build: string[];
  /** Service -> deploy log line for each reused image. */
  reused: Record<string, string>;
  /** Service -> key, for every keyed service. */
  keys: Record<string, string>;
};

/** Keys every build service, retags a matching earlier image for each, and returns what's left to build. */
export async function planComposeReuse(opts: ServiceKeyOpts & {
  services: string[];
  /** `docker compose config --format json` for the slot. */
  config: { services?: Record<string, { build?: BuildSpec; image?: string }> };
  project: string;
  /** Slot directory, for the re-label Dockerfile. */
  workDir: string;
  /** Skip lookups; keys are still computed so the new images carry them. */
  rebuild: boolean;
  docker: Exec;
  log: (line: string) => void;
  /** Build registry checked when the host has no image for a key. */
  registry?: { ops: RegistryOps; appName: string } | null;
}): Promise<ComposeReusePlan> {
  const plan: ComposeReusePlan = { build: [], reused: {}, keys: {} };
  for (const name of opts.services) {
    const svc = opts.config.services?.[name];
    if (!svc?.build) {
      plan.build.push(name);
      continue;
    }
    const keyed = await serviceBuildKey(svc.build, opts);
    if ("reason" in keyed) {
      opts.log(`[build] ${name}: no image reuse, ${keyed.reason}`);
      plan.build.push(name);
      continue;
    }
    plan.keys[name] = keyed.key;
    if (opts.rebuild) {
      plan.build.push(name);
      continue;
    }
    const local = await findImageByKey(opts.docker, keyed.key);
    const image = local ?? (await pullByKey(opts.registry, name, keyed.key));
    if (!image) {
      plan.build.push(name);
      continue;
    }
    try {
      await relabel(opts, image, composeImageName(opts.project, name, svc.image), name);
      plan.reused[name] = local
        ? `[build] ${name}: reused ${image}, nothing build-relevant changed`
        : `[build] ${name}: reused ${image} from the build registry, nothing build-relevant changed`;
    } catch {
      plan.build.push(name);
    } finally {
      if (!local) await opts.registry?.ops.untag(image);
    }
  }
  return plan;
}

/** Pulls a service's image for `key` from the build registry; its ref, or null. */
async function pullByKey(
  registry: { ops: RegistryOps; appName: string } | null | undefined,
  service: string,
  key: string,
): Promise<string | null> {
  if (!registry) return null;
  const ref = registry.ops.ref(serviceRepo(registry.appName, service), key);
  return (await registry.ops.pull(ref)) ? ref : null;
}

/** Newest tagged local image labeled with the key. */
export async function findImageByKey(docker: Exec, key: string): Promise<string | null> {
  try {
    const { stdout } = await docker("docker", [
      "image", "ls", "--filter", `label=${BUILD_KEY_LABEL}=${key}`, "--format", "{{.Repository}}:{{.Tag}}",
    ]);
    return String(stdout).split("\n").map((l) => l.trim()).find((ref) => ref && !ref.includes("<none>")) ?? null;
  } catch {
    return null;
  }
}

/** Dockerfile that re-labels an image without touching its layers. */
export function relabelDockerfile(image: string): string {
  return `FROM ${image}\n`;
}

/**
 * Tags `image` as `target` with this slot's compose labels, on the daemon's own builder (no layers move).
 * A plain `docker tag` would keep the source slot's project label, which image reclaim sorts by.
 */
async function relabel(opts: { project: string; workDir: string; docker: Exec }, image: string, target: string, service: string) {
  const dir = join(opts.workDir, RELABEL_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "Dockerfile"), relabelDockerfile(image));
  await opts.docker("docker", [
    "build", "-q",
    "--label", `com.docker.compose.project=${opts.project}`,
    "--label", `com.docker.compose.service=${service}`,
    "-t", target, dir,
  ]);
}

/** Compose override labeling each keyed service's build. */
export function buildKeysYaml(keys: Record<string, string>): string {
  const services: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(keys)) services[name] = { build: { labels: { [BUILD_KEY_LABEL]: key } } };
  return stringify({ services });
}

/** Writes the override into the slot and returns its `-f` args; none when no service is keyed. */
export async function writeBuildKeysFile(slotDir: string, keys: Record<string, string>): Promise<string[]> {
  if (Object.keys(keys).length === 0) return [];
  const path = join(slotDir, BUILD_KEYS_FILE);
  await writeFile(path, buildKeysYaml(keys));
  return ["-f", path];
}

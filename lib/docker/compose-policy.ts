// Deny-by-default check of `docker compose config` output for untrusted organizations (#886).
// Runs on the resolved model, after interpolation, so `${VAR}`, `.`, `~` and long syntax all arrive as plain paths.

import { existsSync, realpathSync } from "fs";
import { rm } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";
import { DENIED_MOUNT_PATHS } from "./mount-paths";
import { VARDO_HOME_DIR } from "@/lib/paths";
import { NETWORK_NAME, COMPOSE_QUERY_TIMEOUT } from "./constants";
import { DeployBlockedError } from "./errors";

export type ComposePolicy = {
  /** The `-p` the files are resolved with. Project-scoped networks and volumes carry it as a prefix. */
  projectName: string;
  /** Directories the app owns: its environment directory and its repo checkout. */
  ownDirs: string[];
  /** Prefix of the external volumes and networks Vardo creates for this app, e.g. `web-production_`. */
  ownPrefix: string;
  allowBindMounts: boolean;
  allowDockerSocket: boolean;
  /** Resolves symlinks. Defaults to the real filesystem. */
  realpath?: (path: string) => string;
};

const DOCKER_SOCKETS = ["/var/run/docker.sock", "/run/docker.sock"];

// Host paths a bind may never be under or above. "/" is above all of them.
const DENIED_HOST_PATHS = [
  ...DENIED_MOUNT_PATHS,
  ...DOCKER_SOCKETS,
  "/boot",
  "/dev",
  "/run",
  "/var/run",
  "/var/lib/docker",
  "/var/lib/containerd",
  "/run/containerd",
  "/opt/vardo",
  VARDO_HOME_DIR,
];

// Readable by any process on the host; allowed read-only with bind mounts on.
const READ_ONLY_HOST_FILES = ["/etc/localtime", "/etc/timezone"];

const SERVICE_KEYS = new Set([
  "annotations", "attach", "build", "cap_drop", "command", "configs", "container_name",
  "cpu_count", "cpu_percent", "cpu_period", "cpu_quota", "cpu_shares", "cpus", "cpuset",
  "depends_on", "deploy", "dns", "dns_opt", "dns_search", "domainname", "entrypoint",
  "env_file", "environment", "expose", "extra_hosts", "group_add", "healthcheck",
  "hostname", "image", "init", "ipc", "labels", "links", "logging", "mem_limit",
  "mem_reservation", "mem_swappiness", "memswap_limit", "network_mode", "networks",
  "oom_score_adj", "pids_limit", "platform", "ports", "post_start", "pre_stop",
  "privileged", "profiles", "pull_policy", "read_only", "restart", "runtime", "scale",
  "secrets", "security_opt", "shm_size", "stdin_open", "stop_grace_period", "stop_signal",
  "sysctls", "tmpfs", "tty", "ulimits", "user", "volumes", "working_dir",
]);

const BUILD_KEYS = new Set([
  "context", "dockerfile", "dockerfile_inline", "args", "target", "labels", "tags", "pull",
  "no_cache", "platforms", "extra_hosts", "shm_size", "ulimits", "additional_contexts",
  "secrets", "cache_from", "cache_to", "network", "provenance", "sbom",
]);

const RUNTIMES = new Set(["runc", "nvidia", "sysbox-runc"]);
const LOG_DRIVERS = new Set(["json-file", "local", "none"]);
// Vardo's critical tier; the overlay always sets this key.
const MIN_OOM_SCORE_ADJ = -900;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const entries = (v: unknown): [string, unknown][] => (isObj(v) ? Object.entries(v) : []);

function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Real path of `path`, resolving symlinks in the deepest part that exists. */
export function realpathLenient(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return resolve(path);
    tail.unshift(basename(head));
    head = parent;
  }
  return join(realpathSync(head), ...tail);
}

/** Policy errors for a resolved compose model. Empty means the deploy may go ahead. */
export function composePolicyErrors(config: unknown, policy: ComposePolicy): string[] {
  const real = policy.realpath ?? realpathLenient;
  const ownDirs = policy.ownDirs.flatMap((d) => [resolve(d), real(d)]);
  const errors: string[] = [];
  const root = isObj(config) ? config : {};

  const insideApp = (path: string) => {
    const lexical = resolve(path);
    return ownDirs.some((d) => isUnder(lexical, d)) && ownDirs.some((d) => isUnder(real(lexical), d));
  };

  /** Why a host path can't be bound, or null. */
  const hostPathProblem = (source: string, what: string, readOnly = false): string | null => {
    if (!isAbsolute(source)) return `${what} "${source}", which isn't an absolute path`;
    const bindsOff = `${what} host path "${source}", and bind mounts are off for this project`;
    if (insideApp(source)) return policy.allowBindMounts ? null : bindsOff;
    const path = real(source);
    if (DOCKER_SOCKETS.includes(path) || DOCKER_SOCKETS.includes(resolve(source))) {
      return policy.allowDockerSocket ? null : `${what} the Docker socket, and the Docker socket is off for this project`;
    }
    if (!policy.allowBindMounts) return bindsOff;
    if (readOnly && READ_ONLY_HOST_FILES.includes(resolve(source))) return null;
    const under = DENIED_HOST_PATHS.find((p) => isUnder(path, p));
    if (under) return `${what} host path "${source}", and nothing under ${under} can be mounted`;
    const over = DENIED_HOST_PATHS.find((p) => isUnder(p, path));
    return over ? `${what} host path "${source}", which contains ${over}` : null;
  };

  // Paths the compose CLI reads inside the console: always the app's own.
  const appFileProblem = (path: string, what: string): string | null =>
    insideApp(path) ? null : `${what} "${path}" is outside the app's directory`;

  // Top-level volumes.
  const volumes = isObj(root.volumes) ? root.volumes : {};
  for (const [key, raw] of entries(volumes)) {
    const vol = isObj(raw) ? raw : {};
    const name = typeof vol.name === "string" ? vol.name : "";
    if (vol.external) {
      if (!name.startsWith(policy.ownPrefix)) errors.push(`Volume "${key}" uses external volume "${name}", which isn't this app's`);
      continue;
    }
    if (name && name !== `${policy.projectName}_${key}`) {
      errors.push(`Volume "${key}" sets its own name "${name}"`);
    }
    if (vol.driver !== undefined && vol.driver !== "local") {
      errors.push(`Volume "${key}" uses the "${String(vol.driver)}" driver`);
    }
    const opts = isObj(vol.driver_opts) ? vol.driver_opts : null;
    if (opts) {
      const type = String(opts.type ?? "");
      const o = String(opts.o ?? "").split(",").map((s) => s.trim());
      if (o.includes("bind") || o.includes("rbind") || type === "none") {
        const problem = hostPathProblem(String(opts.device ?? ""), `Volume "${key}" binds`);
        if (problem) errors.push(problem);
      } else if (type !== "tmpfs" && !policy.allowBindMounts) {
        errors.push(`Volume "${key}" mounts a "${type}" filesystem, and bind mounts are off for this project`);
      }
    }
    for (const k of Object.keys(vol)) {
      if (!["name", "driver", "driver_opts", "labels"].includes(k)) errors.push(`Volume "${key}" sets "${k}"`);
    }
  }

  // Top-level networks. Vardo's own are external; anything else stays project-scoped.
  const networks = isObj(root.networks) ? root.networks : {};
  const vardoNetworkKeys = new Set<string>();
  for (const [key, raw] of entries(networks)) {
    const net = isObj(raw) ? raw : {};
    const name = typeof net.name === "string" ? net.name : "";
    if (net.external) {
      if (name === NETWORK_NAME) vardoNetworkKeys.add(key);
      else if (!name.startsWith(policy.ownPrefix)) errors.push(`Network "${key}" joins "${name}", which isn't this app's`);
      continue;
    }
    if (name && name !== `${policy.projectName}_${key}`) {
      errors.push(`Network "${key}" sets its own name "${name}"`);
    }
    if (net.driver !== undefined && net.driver !== "bridge") {
      errors.push(`Network "${key}" uses the "${String(net.driver)}" driver`);
    }
    if (net.driver_opts !== undefined && Object.keys(net.driver_opts as Obj).length > 0) {
      errors.push(`Network "${key}" sets driver_opts`);
    }
    for (const k of Object.keys(net)) {
      if (!["name", "driver", "driver_opts", "ipam", "internal", "attachable", "enable_ipv4", "enable_ipv6", "labels"].includes(k)) {
        errors.push(`Network "${key}" sets "${k}"`);
      }
    }
  }

  // Top-level configs and secrets. A file is mounted from the host.
  for (const kind of ["configs", "secrets"] as const) {
    for (const [key, raw] of entries(root[kind])) {
      const item = isObj(raw) ? raw : {};
      const label = `${kind === "configs" ? "Config" : "Secret"} "${key}"`;
      if (item.external) errors.push(`${label} is external`);
      if (typeof item.file === "string" && !insideApp(item.file)) {
        const problem = hostPathProblem(item.file, `${label} reads`);
        if (problem) errors.push(problem);
      }
      for (const k of Object.keys(item)) {
        if (!["name", "file", "content", "environment", "external", "labels"].includes(k)) errors.push(`${label} sets "${k}"`);
      }
    }
  }

  const services = isObj(root.services) ? root.services : {};
  for (const [name, raw] of entries(services)) {
    const svc = isObj(raw) ? raw : {};
    const label = `Service "${name}"`;
    const routed = isObj(svc.labels) && String(svc.labels["traefik.enable"]) === "true";

    for (const key of Object.keys(svc)) {
      if (SERVICE_KEYS.has(key) || key.startsWith("x-") || key === "use_api_socket") continue;
      errors.push(`${label} sets "${key}"`);
    }

    if (svc.privileged === true) errors.push(`${label} is privileged`);
    if (svc.use_api_socket === true && !policy.allowDockerSocket) {
      errors.push(`${label} uses the Docker socket, and the Docker socket is off for this project`);
    }
    for (const opt of Array.isArray(svc.security_opt) ? svc.security_opt : []) {
      if (!/^no-new-privileges(:true)?$/.test(String(opt))) errors.push(`${label} sets security_opt "${String(opt)}"`);
    }
    if (typeof svc.runtime === "string" && !RUNTIMES.has(svc.runtime)) errors.push(`${label} uses the "${svc.runtime}" runtime`);
    if (typeof svc.oom_score_adj === "number" && svc.oom_score_adj < MIN_OOM_SCORE_ADJ) {
      errors.push(`${label} sets oom_score_adj below ${MIN_OOM_SCORE_ADJ}`);
    }
    if (svc.ipc !== undefined && !/^(private|shareable|service:.+)$/.test(String(svc.ipc))) {
      errors.push(`${label} shares the "${String(svc.ipc)}" IPC namespace`);
    }
    if (isObj(svc.logging) && svc.logging.driver !== undefined && !LOG_DRIVERS.has(String(svc.logging.driver))) {
      errors.push(`${label} logs to the "${String(svc.logging.driver)}" driver`);
    }

    const nm = svc.network_mode;
    if (nm !== undefined) {
      const target = typeof nm === "string" && nm.startsWith("service:") ? nm.slice(8) : null;
      if (!(nm === "none" || nm === "bridge" || (target && target in services))) {
        errors.push(`${label} uses network_mode "${String(nm)}"`);
      }
    }

    for (const [net, attach] of entries(svc.networks)) {
      if (vardoNetworkKeys.has(net)) {
        if (!routed) errors.push(`${label} joins ${NETWORK_NAME} without being routed by Vardo`);
        if (isObj(attach) && Object.keys(attach).length > 0) errors.push(`${label} sets addresses or aliases on ${NETWORK_NAME}`);
      }
    }

    for (const mount of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const m = isObj(mount) ? mount : {};
      const target = String(m.target ?? "");
      if (m.type === "bind") {
        const problem = hostPathProblem(String(m.source ?? ""), `${label} mounts`, m.read_only === true);
        if (problem) errors.push(problem);
        const propagation = isObj(m.bind) ? m.bind.propagation : undefined;
        if (propagation !== undefined && !["private", "rprivate"].includes(String(propagation))) {
          errors.push(`${label} sets mount propagation "${String(propagation)}" on ${target}`);
        }
      } else if (m.type === "volume") {
        if (m.source !== undefined && !(String(m.source) in volumes)) {
          errors.push(`${label} mounts undeclared volume "${String(m.source)}"`);
        }
      } else if (m.type !== "tmpfs" && m.type !== "image") {
        errors.push(`${label} uses a "${String(m.type)}" mount at ${target}`);
      }
    }

    for (const ef of Array.isArray(svc.env_file) ? svc.env_file : []) {
      const path = isObj(ef) ? String(ef.path ?? "") : String(ef);
      const problem = appFileProblem(path, `${label} reads env_file`);
      if (problem) errors.push(problem);
    }

    const deploy = isObj(svc.deploy) ? svc.deploy : {};
    const reservations = isObj(deploy.resources) && isObj(deploy.resources.reservations) ? deploy.resources.reservations : {};
    for (const dev of Array.isArray(reservations.devices) ? reservations.devices : []) {
      const caps = isObj(dev) && Array.isArray(dev.capabilities) ? dev.capabilities.map(String) : [];
      if (!caps.includes("gpu")) errors.push(`${label} reserves a device other than a GPU`);
    }

    if (svc.build !== undefined) errors.push(...buildErrors(label, svc.build, appFileProblem));
  }

  return [...new Set(errors)];
}

function buildErrors(
  label: string,
  build: unknown,
  appFileProblem: (path: string, what: string) => string | null,
): string[] {
  const errors: string[] = [];
  const b = isObj(build) ? build : { context: build };
  const context = String(b.context ?? "");

  for (const key of Object.keys(b)) {
    if (!BUILD_KEYS.has(key)) errors.push(`${label} sets build "${key}"`);
  }

  const contextProblem = appFileProblem(context, `${label} builds from`);
  if (contextProblem) errors.push(contextProblem);
  else if (typeof b.dockerfile === "string" && b.dockerfile_inline === undefined) {
    const problem = appFileProblem(resolve(context, b.dockerfile), `${label} reads Dockerfile`);
    if (problem) errors.push(problem);
  }

  for (const [name, value] of entries(b.additional_contexts)) {
    const v = String(value);
    if (/^(docker-image:\/\/|service:|target:)/.test(v)) continue;
    const problem = appFileProblem(v, `${label} adds build context "${name}" from`);
    if (problem) errors.push(problem);
  }

  if (b.network !== undefined && !["default", "none"].includes(String(b.network))) {
    errors.push(`${label} builds on the "${String(b.network)}" network`);
  }

  for (const cache of [b.cache_from, b.cache_to].flatMap((c) => (Array.isArray(c) ? c : []))) {
    const type = /(?:^|,)type=([^,]+)/.exec(String(cache))?.[1];
    if (type && !["registry", "inline", "gha"].includes(type)) errors.push(`${label} uses a "${type}" build cache`);
  }

  return errors;
}

/** `docker compose config` for the slot's files, as `up` will see them. */
export async function resolveComposeConfig(opts: {
  cwd: string;
  composeFileArgs: string[];
  projectName: string;
}): Promise<unknown> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose", ...opts.composeFileArgs, "-p", opts.projectName, "--profile", "*",
      "config", "--format", "json", "--no-env-resolution",
    ],
    { env: dockerEnv(), cwd: opts.cwd, timeout: COMPOSE_QUERY_TIMEOUT * 3, maxBuffer: 10 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

/** `repoDir/rootDirectory`, refused when it leaves the repo. */
export function appRootDir(repoDir: string, rootDirectory: string | null | undefined): string {
  if (!rootDirectory) return repoDir;
  const root = resolve(join(repoDir, rootDirectory));
  const repo = realpathLenient(repoDir);
  if (!isUnder(root, resolve(repoDir)) || !isUnder(realpathLenient(root), repo)) {
    throw new DeployBlockedError(`Couldn't deploy: root directory "${rootDirectory}" is outside the repository.`);
  }
  return root;
}

/** Refuses the deploy when the slot's resolved compose reaches outside the app. Removes the slot's files on refusal. */
export async function assertComposeWithinApp(ctx: {
  slotDir: string;
  appDir: string;
  repoDir: string | null;
  newProjectName: string;
  stableVolumePrefix: string;
  composeFileArgs: string[];
  projectAllowBindMounts: boolean;
  projectAllowDockerSocket: boolean;
}): Promise<void> {
  let errors: string[];
  try {
    const config = await resolveComposeConfig({
      cwd: ctx.slotDir,
      composeFileArgs: ctx.composeFileArgs,
      projectName: ctx.newProjectName,
    });
    errors = composePolicyErrors(config, {
      projectName: ctx.newProjectName,
      ownDirs: [ctx.appDir, ...(ctx.repoDir ? [ctx.repoDir] : [])],
      ownPrefix: `${ctx.stableVolumePrefix}_`,
      allowBindMounts: ctx.projectAllowBindMounts,
      allowDockerSocket: ctx.projectAllowDockerSocket,
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    errors = [`Couldn't read the compose file: ${stderr || (err instanceof Error ? err.message : String(err))}`];
  }
  if (errors.length === 0) return;

  for (const file of ["docker-compose.yml", "docker-compose.override.yml", ".env"]) {
    await rm(join(ctx.slotDir, file), { force: true }).catch(() => {});
  }
  throw new DeployBlockedError(
    `Couldn't deploy: the compose file reaches outside the app.\n${errors.map((e) => `- ${e}`).join("\n")}\n` +
      `An instance admin can allow bind mounts or the Docker socket for the project, or mark the organization trusted under Admin → Organizations.`,
  );
}

// Nixpacks as a Dockerfile, so its builds run on the bounded BuildKit like any Dockerfile build.

import { readFile, rm } from "fs/promises";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "./docker-env";
import { nixpacksGenerateArgs, nixpacksPlanArgs, type BuildOverrides } from "./buildpack-args";
import { planErrorReason } from "./build-plan";

/** Where `nixpacks build --out <dir>` writes its Dockerfile and nix files. */
export const NIXPACKS_DIR = ".nixpacks";

const TIMEOUT = 60_000;
const MAX_BUFFER = 4 * 1024 * 1024;

export type NixpacksDockerfile = {
  /** Absolute path of the generated Dockerfile; the build context is the source dir. */
  dockerfile: string;
  /** The plan's variables. The Dockerfile declares each as an ARG and bakes it into ENV. */
  buildArgs: Record<string, string>;
};

type Exec = (cmd: string, args: string[], opts: Record<string, unknown>) => Promise<{ stdout: string | Buffer }>;

/** The plan's `variables`, or null when the output has none. */
export function planVariables(stdout: string): Record<string, string> | null {
  const plan = JSON.parse(stdout) as { variables?: unknown };
  const vars = plan?.variables;
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars)) out[k] = String(v);
  return out;
}

/** Writes `<source>/.nixpacks/Dockerfile`. Null, with the reason logged, when Nixpacks can't. */
export async function generateNixpacksDockerfile(opts: {
  source: string;
  cacheKey: string;
  envVars?: Record<string, string>;
  overrides?: BuildOverrides;
  log: (line: string) => void;
  signal?: AbortSignal;
  exec?: Exec;
}): Promise<NixpacksDockerfile | null> {
  const exec = opts.exec ?? (execFileAsync as unknown as Exec);
  // App vars go in --env only, never the process env.
  const limits = { cwd: opts.source, timeout: TIMEOUT, maxBuffer: MAX_BUFFER, signal: opts.signal };
  const dir = join(opts.source, NIXPACKS_DIR);
  try {
    await rm(dir, { recursive: true, force: true });
    const plan = await exec("nixpacks", nixpacksPlanArgs(opts.source, opts.envVars, opts.overrides), { ...limits, env: dockerEnv() });
    const buildArgs = planVariables(String(plan.stdout));
    if (!buildArgs) throw new Error("plan has no variables");
    await exec("nixpacks", nixpacksGenerateArgs(opts.source, opts.cacheKey, opts.envVars, opts.overrides), { ...limits, env: dockerEnv() });
    const dockerfile = join(dir, "Dockerfile");
    await readFile(dockerfile, "utf-8");
    return { dockerfile, buildArgs };
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    const reason = err instanceof Error && !("code" in err) && !("stderr" in err) && !(err instanceof SyntaxError)
      ? err.message
      : planErrorReason(err);
    opts.log(`[build] Couldn't generate the Nixpacks Dockerfile, building with Nixpacks directly: ${reason}`);
    await removeNixpacksDir(opts.source);
    return null;
  }
}

/** Removes the generated files from the build tree. */
export async function removeNixpacksDir(source: string): Promise<void> {
  await rm(join(source, NIXPACKS_DIR), { recursive: true, force: true }).catch(() => {});
}

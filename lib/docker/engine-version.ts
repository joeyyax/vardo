// Version of the tool a repo build runs, for the build key. Read once per ten minutes.

import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: string }>();

const COMMANDS: Record<string, [string, string[]]> = {
  railpack: ["railpack", ["--version"]],
  nixpacks: ["nixpacks", ["--version"]],
  dockerfile: ["docker", ["version", "--format", "{{.Server.Version}}"]],
};

/** The engine's version string, or "unknown" when it can't be read. */
export async function engineVersion(engine: "dockerfile" | "railpack" | "nixpacks"): Promise<string> {
  const hit = cache.get(engine);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [cmd, args] = COMMANDS[engine];
  let value = "unknown";
  try {
    const { stdout } = await execFileAsync(cmd, args, { env: dockerEnv(), timeout: 10_000 });
    value = stdout.trim() || "unknown";
  } catch {
    // Unknown still keys consistently.
  }
  cache.set(engine, { at: Date.now(), value });
  return value;
}

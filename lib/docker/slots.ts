// ---------------------------------------------------------------------------
// Blue-green slot resolution.
//
// The "active slot" is the one currently serving — and, crucially, the one
// holding any host ports. It MUST be identified so the deploy can tear it down
// before starting the new slot. If a stale slot is left running (e.g. recreated
// by a `restart:` policy after a host reboot, or an app that predates the
// `current` symlink), failing to detect it means the new slot collides on the
// host port: "Bind for 0.0.0.0:<port> failed: port is already allocated".
// ---------------------------------------------------------------------------

import { readlink, readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";

const execFileAsync = promisify(execFile);

export type Slot = "blue" | "green";

/** Injectable probes — real implementations hit the filesystem / Docker. */
export type SlotProbes = {
  readSymlink: (path: string) => Promise<string>;
  readActiveFile: (path: string) => Promise<string>;
  isSlotRunning: (projectName: string) => Promise<boolean>;
};

const defaultProbes: SlotProbes = {
  readSymlink: (path) => readlink(path),
  readActiveFile: (path) => readFile(path, "utf-8"),
  isSlotRunning: async (projectName) => {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "-q", "--filter", `label=com.docker.compose.project=${projectName}`],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return stdout.trim().length > 0;
  },
};

function asSlot(value: string): Slot | null {
  const v = value.trim();
  return v === "blue" || v === "green" ? v : null;
}

/**
 * Resolve which slot is currently active for a blue-green app.
 *
 * Resolution order:
 *  1. `current` symlink — vardo's authoritative pointer once a deploy succeeds.
 *  2. Docker ground-truth — a slot project with running containers. This is what
 *     actually holds host ports, so it's the one that must be torn down. Catches
 *     apps that predate the symlink (legacy `.active-slot`) and symlinks that
 *     drifted from reality (a host reboot re-running `restart:` containers).
 *  3. Legacy `.active-slot` file — the pre-symlink migration artifact.
 *
 * Returns null only when no slot is detectable — a genuine first deploy.
 *
 * `projectPrefix` is the compose project name without the slot suffix
 * (`${appName}-${envName}`); slot projects are `${projectPrefix}-${slot}`.
 */
export async function detectActiveSlot(
  appDir: string,
  projectPrefix: string,
  probes: SlotProbes = defaultProbes,
): Promise<Slot | null> {
  // 1. Authoritative pointer
  try {
    const slot = asSlot(await probes.readSymlink(join(appDir, "current")));
    if (slot) return slot;
  } catch {
    /* no symlink yet — fall through */
  }

  // 2. Docker ground-truth — a running slot is the real host-port holder
  for (const slot of ["blue", "green"] as const) {
    try {
      if (await probes.isSlotRunning(`${projectPrefix}-${slot}`)) return slot;
    } catch {
      /* probe failed — try the other slot */
    }
  }

  // 3. Legacy migration artifact
  try {
    const slot = asSlot(await probes.readActiveFile(join(appDir, ".active-slot")));
    if (slot) return slot;
  } catch {
    /* no legacy file */
  }

  return null;
}

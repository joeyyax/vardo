// Blue-green slot resolution. Missing a running slot makes the new one collide on its host ports.

import { readlink, readFile } from "fs/promises";
import { join } from "path";
import { COMPOSE_QUERY_TIMEOUT } from "./constants";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

export type Slot = "blue" | "green";

/** Injectable filesystem and Docker probes. */
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
      { env: dockerEnv(), timeout: COMPOSE_QUERY_TIMEOUT },
    );
    return stdout.trim().length > 0;
  },
};

function asSlot(value: string): Slot | null {
  const v = value.trim();
  return v === "blue" || v === "green" ? v : null;
}

/** Docker's answer for a slot project, or null when the probe itself failed. */
async function slotRunning(
  probes: SlotProbes,
  projectName: string,
): Promise<boolean | null> {
  try {
    return await probes.isSlotRunning(projectName);
  } catch {
    return null;
  }
}

/** Active slot: symlink (unless Docker proves it stale), then running containers, then legacy .active-slot. Null on first deploy. */
export async function detectActiveSlot(
  appDir: string,
  projectPrefix: string,
  probes: SlotProbes = defaultProbes,
): Promise<Slot | null> {
  // Overruled only when its slot is confirmed stopped and the other confirmed running; a failed probe never demotes it.
  try {
    const slot = asSlot(await probes.readSymlink(join(appDir, "current")));
    if (slot) {
      if ((await slotRunning(probes, `${projectPrefix}-${slot}`)) === false) {
        const other: Slot = slot === "blue" ? "green" : "blue";
        if ((await slotRunning(probes, `${projectPrefix}-${other}`)) === true) {
          return other;
        }
      }
      return slot;
    }
  } catch {
    /* no symlink */
  }

  // A running slot holds the host ports. Blue first is a stable tie-break.
  for (const slot of ["blue", "green"] as const) {
    try {
      if (await probes.isSlotRunning(`${projectPrefix}-${slot}`)) return slot;
    } catch {
      /* probe failed */
    }
  }

  // Legacy migration artifact.
  try {
    const slot = asSlot(await probes.readActiveFile(join(appDir, ".active-slot")));
    if (slot) return slot;
  } catch {
    /* no legacy file */
  }

  return null;
}

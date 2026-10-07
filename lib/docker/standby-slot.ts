// Stops a standby slot that a daemon restart brought back up, which would split Traefik traffic across two versions.

import { readlink } from "fs/promises";
import { join } from "path";
import { execFileAsync } from "@/lib/utils/exec";

import { COMPOSE_QUERY_TIMEOUT, COMPOSE_DOWN_TIMEOUT } from "./constants";
import { slotComposeFiles } from "./compose-inject";
import { demoteStandbyRestart } from "./restart-policy";
import { logger } from "@/lib/logger";
import type { Slot } from "./slots";

const log = logger.child("standby-slot");

export const SLOTS: readonly Slot[] = ["blue", "green"];

/** The other slot. */
export function otherSlot(slot: Slot): Slot {
  return slot === "blue" ? "green" : "blue";
}

export type StandbyVerdict =
  /** `refused` separates "cannot tell, leave it" from "nothing to do". */
  | { act: false; refused: boolean; reason: string }
  | { act: true; standby: Slot };

/**
 * Decide whether a standby slot can be reclaimed.
 * Refuses unless the `current` symlink resolves and Docker agrees that slot is up; a wrong guess stops the serving slot.
 */
export function decideStandbySweep(input: {
  /** `current` target, or null when it is missing, unreadable or not a slot. */
  currentSlot: Slot | null;
  /** Per-slot running state, or null when Docker could not be read. */
  running: Record<Slot, boolean> | null;
}): StandbyVerdict {
  const { currentSlot, running } = input;

  if (running === null) {
    return { act: false, refused: true, reason: "Docker could not be read" };
  }
  if (currentSlot === null) {
    return {
      act: false,
      refused: true,
      reason: "no 'current' symlink to identify the live slot",
    };
  }

  // Symlink and Docker disagree; the running slot may be serving.
  if (!running[currentSlot]) {
    return {
      act: false,
      refused: true,
      reason: `'current' points at ${currentSlot}, which is not running`,
    };
  }

  const standby = otherSlot(currentSlot);
  if (!running[standby]) {
    return { act: false, refused: false, reason: "no standby is running" };
  }

  return { act: true, standby };
}

/** Compose project names with at least one running container, or null on failure. */
export async function runningProjects(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.Label \"com.docker.compose.project\"}}"],
      { timeout: COMPOSE_QUERY_TIMEOUT },
    );
    const names = stdout.trim().split("\n").map((n) => n.trim()).filter(Boolean);
    // Empty means a failed probe: Vardo itself runs in a container.
    if (names.length === 0) return null;
    return new Set(names);
  } catch (err) {
    log.warn("Could not list running compose projects:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** `current` symlink target when it names a slot, else null. */
export async function readCurrentSlot(appDir: string): Promise<Slot | null> {
  try {
    const target = (await readlink(join(appDir, "current"))).trim();
    return target === "blue" || target === "green" ? target : null;
  } catch {
    return null;
  }
}

/** Stop a reclaimed standby and pin it to `restart: no`. `stop`, not `down`: containers stay for instant rollback. */
export async function stopStandbySlot(
  appDir: string,
  projectPrefix: string,
  standby: Slot,
): Promise<void> {
  const slotDir = join(appDir, standby);
  const projectName = `${projectPrefix}-${standby}`;
  const composeFileArgs = await slotComposeFiles(slotDir);

  await demoteStandbyRestart(composeFileArgs, projectName, slotDir);
  await execFileAsync(
    "docker",
    ["compose", ...composeFileArgs, "-p", projectName, "stop"],
    { cwd: slotDir, timeout: COMPOSE_DOWN_TIMEOUT },
  );
}

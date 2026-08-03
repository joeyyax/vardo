// ---------------------------------------------------------------------------
// Standby slot reclamation
//
// A demoted standby is stopped and pinned to `restart: no`, but neither holds
// forever: a daemon restart can restore a stopped container and start it back
// up, policy and all. Both slots then carry the same Traefik labels, so Traefik
// merges them into one load balancer and splits requests across two versions.
// This finds a standby that came back and stops it again.
// ---------------------------------------------------------------------------

import { execFile } from "child_process";
import { promisify } from "util";
import { readlink } from "fs/promises";
import { join } from "path";

import { COMPOSE_QUERY_TIMEOUT, COMPOSE_DOWN_TIMEOUT } from "./constants";
import { slotComposeFiles } from "./compose-inject";
import { demoteStandbyRestart } from "./restart-policy";
import { logger } from "@/lib/logger";
import type { Slot } from "./slots";

const execFileAsync = promisify(execFile);
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
 * Decide whether a slot can be reclaimed, from the `current` symlink and what
 * Docker reports running.
 *
 * The symlink is the only authority on which slot is live — both slot dirs share
 * one git dir, so their shas are identical and prove nothing. Every answer short
 * of "the symlink resolves and Docker agrees the slot it names is up" refuses,
 * because the cost of guessing wrong is stopping the slot that is serving.
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

  // The symlink names a slot that is not up. Docker and the symlink disagree
  // about what is serving, and the running slot may be the one users reach.
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
    // An empty list reads as a failed probe, not as an idle host. Vardo itself
    // runs in a container here, so nothing running means the read is wrong.
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

/**
 * Stop a reclaimed standby and pin it back to `restart: no`.
 *
 * `stop`, not `down` — the containers stay for instant rollback, exactly as the
 * deploy's own teardown leaves them.
 */
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

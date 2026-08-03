// ---------------------------------------------------------------------------
// Which slot directory an already-deployed app is currently served from.
//
// deploy.ts still carries a private copy for stop/restart; fold it into this
// one when touching that file next.
// ---------------------------------------------------------------------------

import { access, readlink } from "fs/promises";
import { join } from "path";

import { detectActiveSlot } from "./slots";

/**
 * Slot directory and compose project name for the running deployment.
 * Local environments use a single `local/` directory with no slot suffix.
 */
export async function resolveActiveSlot(
  dir: string,
  projectPrefix: string,
): Promise<{ slotDir: string; composeProject: string }> {
  try {
    await access(join(dir, "local"));
    // A `local/` directory with no `current` symlink is a local environment.
    try {
      await readlink(join(dir, "current"));
    } catch {
      return { slotDir: join(dir, "local"), composeProject: projectPrefix };
    }
  } catch {
    // No local/ directory — standard blue-green.
  }

  // Same resolution as the deploy path: symlink → running slot → legacy file.
  // Falls back to blue when nothing is detectable, which leaves the caller
  // driving a project that does not exist.
  const activeSlot = (await detectActiveSlot(dir, projectPrefix)) ?? "blue";

  return {
    slotDir: join(dir, activeSlot),
    composeProject: `${projectPrefix}-${activeSlot}`,
  };
}

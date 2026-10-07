// Which slot directory an already-deployed app is served from.

import { access, readlink, rename, rm, symlink } from "fs/promises";
import { join } from "path";

import { detectActiveSlot } from "./slots";

/** Slot directory and compose project for the running deployment. Local environments use `local/` with no slot suffix. */
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
    // Blue-green.
  }

  // Blue when nothing is detectable.
  const activeSlot = (await detectActiveSlot(dir, projectPrefix)) ?? "blue";

  return {
    slotDir: join(dir, activeSlot),
    composeProject: `${projectPrefix}-${activeSlot}`,
  };
}

/** Point `<appDir>/current` at a slot, atomically. */
export async function pointCurrentAt(appDir: string, slot: string): Promise<void> {
  await rm(join(appDir, ".active-slot"), { force: true }).catch(() => {});
  const tmp = join(appDir, "current.tmp");
  await rm(tmp, { force: true });
  await symlink(slot, tmp, "dir");
  await rename(tmp, join(appDir, "current"));
}

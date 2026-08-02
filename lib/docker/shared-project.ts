// ---------------------------------------------------------------------------
// Reading the slot/shared split back off disk.
//
// A deploy writes one compose file per slot holding every service, and runs it
// twice: the rotating services under `${app}-${env}-${slot}` and the
// x-vardo-shared ones under `${app}-${env}-shared`. Anything that later drives
// that compose file — stop, restart, rollback — has to make the same split, or
// an unqualified `up` starts a second copy of the database in the slot project.
// ---------------------------------------------------------------------------

import { readFile } from "fs/promises";
import { join } from "path";
import { parseCompose } from "./compose-parse";
import { partitionBySlot, type SlotPartition } from "./slot-partition";

/** Injectable so callers can be tested without a slot directory on disk. */
export type ComposeReader = (path: string) => Promise<string>;

const defaultReader: ComposeReader = (path) => readFile(path, "utf-8");

/**
 * Partition the compose a slot was deployed from, or null when nothing in it
 * is shared.
 *
 * Null is the answer for the overwhelming majority of apps, and callers are
 * expected to run exactly the command they always did in that case. A missing,
 * unreadable or all-shared compose also reads as null — there is no safe
 * two-project command to derive from it.
 */
export async function readSlotPartition(
  slotDir: string,
  read: ComposeReader = defaultReader,
): Promise<SlotPartition | null> {
  try {
    const partition = partitionBySlot(parseCompose(await read(join(slotDir, "docker-compose.yml"))));
    return Object.keys(partition.shared).length > 0 ? partition : null;
  } catch {
    return null;
  }
}

/**
 * `docker compose` arguments confining a command to the shared set.
 * `--no-deps` keeps compose from dragging a slotted service in behind it.
 */
export function sharedScopeArgs(partition: SlotPartition): string[] {
  return ["--no-deps", ...Object.keys(partition.shared)];
}

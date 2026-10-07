// Reads a slot compose's slot/shared split back off disk.
// Stop, restart and rollback must split the same way or `up` starts a second database in the slot project.

import { readFile } from "fs/promises";
import { join } from "path";
import { parseCompose } from "./compose-parse";
import { partitionBySlot, type SlotPartition } from "./slot-partition";

/** Injectable for tests. */
export type ComposeReader = (path: string) => Promise<string>;

const defaultReader: ComposeReader = (path) => readFile(path, "utf-8");

/** Partition a slot's deployed compose, or null when nothing is shared or it can't be read. */
export async function readSlotPartition(
  slotDir: string,
  read: ComposeReader = defaultReader,
): Promise<(SlotPartition & { composeName?: string }) | null> {
  try {
    const compose = parseCompose(await read(join(slotDir, "docker-compose.yml")));
    const partition = partitionBySlot(compose);
    if (Object.keys(partition.shared).length === 0) return null;
    return compose.name ? { ...partition, composeName: compose.name } : partition;
  } catch {
    return null;
  }
}

/** `docker compose` args confining a command to the shared set. `--no-deps` keeps slotted services out. */
export function sharedScopeArgs(partition: SlotPartition): string[] {
  return ["--no-deps", ...Object.keys(partition.shared)];
}

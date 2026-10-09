// Free-space checks run before a restore or drill downloads anything.

import { statfs } from "fs/promises";
import { formatBytes } from "@/lib/metrics/format";
import { dockerEnv } from "@/lib/docker/docker-env";
import { execFileAsync } from "@/lib/utils/exec";

export const SPACE_MARGIN = 0.1;

/** One filesystem a restore writes to, and what it needs there. */
export type SpaceNeed = {
  label: string;
  path: string;
  neededBytes: number;
  /** Null when it couldn't be measured; the check then passes with a warning. */
  freeBytes: number | null;
  why: string;
};

export class InsufficientSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientSpaceError";
  }
}

/** Staging holds the download, plus the decrypted copy until the sealed one is removed. */
export function stagingNeed(archiveBytes: number, encrypted: boolean): { bytes: number; why: string } {
  const copies = encrypted ? 2 : 1;
  return {
    bytes: Math.ceil(archiveBytes * copies * (1 + SPACE_MARGIN)),
    why: encrypted ? "the download and its decrypted copy, plus 10%" : "the download, plus 10%",
  };
}

/** A file restore writes at least the archive's size into its destination. */
export function targetNeed(archiveBytes: number): { bytes: number; why: string } {
  return { bytes: Math.ceil(archiveBytes * (1 + SPACE_MARGIN)), why: "the archive's size, plus 10%" };
}

/** Free bytes on the filesystem holding `path`, as this process sees it. */
export async function localFreeBytes(path: string): Promise<number | null> {
  try {
    const s = await statfs(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Free bytes on a host path, measured through the daemon: this process may run in a container. */
export async function hostFreeBytes(hostPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["run", "--rm", "--network", "none", "--mount", `type=bind,source=${hostPath},target=/probe,readonly`, "alpine", "df", "-Pk", "/probe"],
      { env: dockerEnv(), timeout: 60_000 },
    );
    const fields = String(stdout).trim().split("\n").at(-1)?.trim().split(/\s+/) ?? [];
    const availableKb = Number(fields[3]);
    return Number.isFinite(availableKb) && fields.length >= 4 ? availableKb * 1024 : null;
  } catch {
    return null;
  }
}

/** Throw naming every filesystem that's short. Unmeasured ones are logged and skipped. */
export function assertSpace(needs: SpaceNeed[], log: (msg: string) => void): void {
  const short: string[] = [];
  for (const n of needs) {
    if (n.freeBytes === null) {
      log(`WARNING: couldn't measure free space on the ${n.label} (${n.path}); continuing`);
      continue;
    }
    if (n.freeBytes < n.neededBytes) {
      short.push(
        `the ${n.label} (${n.path}) has ${formatBytes(n.freeBytes)} free and needs ${formatBytes(n.neededBytes)} (${n.why})`,
      );
    } else {
      log(`Free space on the ${n.label}: ${formatBytes(n.freeBytes)}, needs ${formatBytes(n.neededBytes)}`);
    }
  }
  if (short.length) throw new InsufficientSpaceError(`Not enough disk space: ${short.join("; ")}`);
}

// The database phase can't keep its state in the database it replaces, so it lives in a file.

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
import { createHash, timingSafeEqual } from "crypto";
import { VARDO_HOME_DIR } from "@/lib/paths";

export type RestoreMarker = {
  runId: string;
  phase: "database" | "failed";
  systemBackupKey: string;
  systemBackupAt: string;
  startedAt: string;
  /** SHA-256 of the token the starting browser holds. */
  tokenHash: string;
  error?: string;
  log?: string;
};

export function markerPath(): string {
  return join(VARDO_HOME_DIR, "restore", "database.json");
}

export async function readMarker(): Promise<RestoreMarker | null> {
  try {
    return JSON.parse(await readFile(markerPath(), "utf-8")) as RestoreMarker;
  } catch {
    return null;
  }
}

export async function writeMarker(marker: RestoreMarker): Promise<void> {
  const path = markerPath();
  await mkdir(join(VARDO_HOME_DIR, "restore"), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(marker), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

export async function clearMarker(): Promise<void> {
  await rm(markerPath(), { force: true });
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(marker: RestoreMarker, token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(marker.tokenHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

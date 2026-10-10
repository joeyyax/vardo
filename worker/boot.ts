// Worker boot state: waits for the schema this image expects, then tracks readiness and drain for /healthz.

import { readFile } from "fs/promises";
import { join } from "path";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

const log = logger.child("worker");

type BootState = { booted: boolean; draining: boolean; stopping: boolean; bootError: string | null };

const state: BootState = { booted: false, draining: false, stopping: false, bootError: null };

export const bootState = (): Readonly<BootState> => state;
export const markBooted = () => void (state.booted = true);
export const markDraining = () => void (state.draining = true);
/** Stops boot retries; set on SIGTERM. */
export const markStopping = () => void (state.stopping = true);

/** Migration tags in this image's drizzle journal. */
export async function journalTags(dir = join(process.cwd(), "drizzle")): Promise<string[]> {
  const journal = JSON.parse(await readFile(join(dir, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  return journal.entries.map((e) => e.tag);
}

/** Tags the database hasn't applied. */
export function missingMigrations(expected: string[], applied: Iterable<string>): string[] {
  const have = new Set(applied);
  return expected.filter((tag) => !have.has(tag));
}

/** Throws until every migration in this image's journal is applied. The web container runs them. */
export async function assertSchemaCurrent(): Promise<void> {
  const [tags, rows] = await Promise.all([journalTags(), db.execute<{ hash: string }>(sql`SELECT hash FROM __drizzle_migrations`)]);
  const missing = missingMigrations(tags, rows.map((r) => r.hash));
  if (missing.length > 0) throw new Error(`${missing.length} migration(s) not applied yet, first ${missing[0]}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/** Retries `step` with backoff from 1s to 30s. False when a shutdown interrupts it. */
export async function awaitBoot(label: string, step: () => Promise<void>, delays = { firstMs: 1000, maxMs: 30_000 }): Promise<boolean> {
  let delayMs = delays.firstMs;
  for (;;) {
    if (state.stopping) return false;
    try {
      await step();
      state.bootError = null;
      return true;
    } catch (err) {
      state.bootError = err instanceof Error ? err.message : String(err);
      log.warn(`${label}: ${state.bootError}; retrying in ${Math.round(delayMs / 1000)}s`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, delays.maxMs);
    }
  }
}

/** Tests only. */
export function resetBootState(): void {
  Object.assign(state, { booted: false, draining: false, stopping: false, bootError: null });
}

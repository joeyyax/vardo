// Volumes no container mounts and nothing in Vardo claims. Listed for review; never removed automatically.
// Anything that could be a live app's data stays off the list: name prefixes, compose text and volume rows all count.

import { readFile } from "fs/promises";
import { join } from "path";
import { db } from "@/lib/db";
import { deployments, volumes as volumeRows } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { appBaseDir } from "@/lib/paths";
import { VARDO_SELF_APP_NAME } from "@/lib/self-app-name";
import { getVolumeSizes, removeVolume } from "./client";
import { slotDirsOf, within } from "./app-data";
import { loadSnapshot, resolveDetached, type Snapshot } from "./detached-volumes";

export type OrphanKind = "anonymous" | "unclaimed";

export type OrphanVolume = {
  name: string;
  kind: OrphanKind;
  /** Compose project label, when the volume has one. */
  project: string | null;
  createdAt: string | null;
  sizeBytes: number | null;
};

/** Volumes younger than this may belong to a deploy that hasn't started its containers yet. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60_000;

export type OrphanSnapshot = Snapshot & {
  /** Names and sources from Vardo's volume records. */
  recordNames: Set<string>;
  /** Compose files from the database and the app directories, as text. */
  composeTexts: string[];
  now: number;
};

const ANONYMOUS = /^[0-9a-f]{64}$/;

function claimedByName(name: string, owners: Iterable<string>): boolean {
  for (const owner of owners) {
    if (name === owner || name.startsWith(`${owner}-`) || name.startsWith(`${owner}_`)) return true;
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentioned(name: string, texts: string[]): boolean {
  const token = new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRegExp(name)}($|[^A-Za-z0-9_.-])`);
  return texts.some((t) => t.includes(name) && token.test(t));
}

/** Pure. Detached volumes are excluded; they have their own list. */
export function resolveOrphans(snap: OrphanSnapshot): Omit<OrphanVolume, "sizeBytes">[] {
  const detached = new Set(resolveDetached(snap).volumes.map((v) => v.name));
  const owners = [...snap.liveAppNames, VARDO_SELF_APP_NAME];

  const orphans: Omit<OrphanVolume, "sizeBytes">[] = [];
  for (const vol of snap.volumes) {
    if (snap.mounted.has(vol.name) || snap.liveVolumes.has(vol.name) || detached.has(vol.name)) continue;
    if (snap.recordNames.has(vol.name)) continue;

    const project = vol.labels["com.docker.compose.project"] ?? null;
    if (project && (snap.containerProjects.has(project) || claimedByName(project, owners))) continue;
    if (claimedByName(vol.name, owners)) continue;

    const created = vol.createdAt ? Date.parse(vol.createdAt) : NaN;
    if (!Number.isFinite(created) || snap.now - created < ORPHAN_MIN_AGE_MS) continue;

    const anonymous = ANONYMOUS.test(vol.name) || vol.labels["com.docker.volume.anonymous"] !== undefined;
    // A hash name means nothing to grep for; a real name mentioned anywhere is someone's.
    if (!anonymous && mentioned(vol.name, snap.composeTexts)) continue;

    orphans.push({ name: vol.name, kind: anonymous ? "anonymous" : "unclaimed", project, createdAt: vol.createdAt ?? null });
  }
  return orphans.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.override.yml"];

async function diskComposeTexts(dirNames: string[]): Promise<string[]> {
  const texts: string[] = [];
  for (const name of dirNames) {
    for (const slotDir of await slotDirsOf(appBaseDir(name))) {
      for (const file of COMPOSE_FILES) {
        const text = await readFile(join(slotDir, file), "utf8").catch(() => null);
        if (text) texts.push(text);
      }
    }
  }
  return texts;
}

export async function loadOrphanSnapshot(now = Date.now()): Promise<OrphanSnapshot> {
  const base = await loadSnapshot();
  const [records, appCompose, snapshotCompose, diskTexts] = await Promise.all([
    db.select({ name: volumeRows.name, source: volumeRows.source }).from(volumeRows),
    db.query.apps.findMany({ columns: { composeContent: true } }),
    db.select({ config: deployments.configSnapshot }).from(deployments).where(eq(deployments.status, "success")),
    diskComposeTexts(base.dirNames),
  ]);

  const recordNames = new Set<string>();
  for (const r of records) {
    recordNames.add(r.name);
    if (r.source) recordNames.add(r.source);
  }
  const composeTexts = [
    ...appCompose.map((a) => a.composeContent).filter((t): t is string => !!t),
    ...snapshotCompose.map((d) => d.config?.composeContent).filter((t): t is string => !!t),
    ...diskTexts,
  ];
  return { ...base, recordNames, composeTexts, now };
}

export async function findOrphanVolumes(load: () => Promise<OrphanSnapshot> = loadOrphanSnapshot): Promise<OrphanVolume[]> {
  return resolveOrphans(await load()).map((v) => ({ ...v, sizeBytes: null }));
}

/** /system/df walks every volume: a minute or more on a big host. */
export const VOLUME_DF_TIMEOUT_MS = 180_000;
const SIZES_TTL_MS = 2 * 60_000;
/** How long one request waits on df before answering that it's still measuring. */
export const SIZES_WAIT_MS = 20_000;

type Sizes = Map<string, number>;
type SizesCache = { sizes: Sizes | null; at: number; pending: Promise<Sizes | null> | null };

// On globalThis so every route bundle shares one df.
const g = globalThis as unknown as { __vardo_volume_sizes?: SizesCache };
const sizesCache = (g.__vardo_volume_sizes ??= { sizes: null, at: 0, pending: null });

/** Volume sizes from one shared df, cached briefly. Null when df failed or timed out. */
export function volumeSizes(
  df: () => Promise<Sizes> = () => getVolumeSizes({ timeoutMs: VOLUME_DF_TIMEOUT_MS }),
): Promise<Sizes | null> {
  if (sizesCache.sizes && Date.now() - sizesCache.at < SIZES_TTL_MS) return Promise.resolve(sizesCache.sizes);
  sizesCache.pending ??= df()
    .then((sizes) => {
      sizesCache.sizes = sizes;
      sizesCache.at = Date.now();
      return sizes;
    })
    .catch(() => null)
    .finally(() => {
      sizesCache.pending = null;
    });
  return sizesCache.pending;
}

/** Clears the size cache. For tests. */
export function resetVolumeSizes(): void {
  sizesCache.sizes = null;
  sizesCache.at = 0;
  sizesCache.pending = null;
}

const STILL_MEASURING = Symbol("measuring");

/** Fills in sizes, waiting up to `waitMs` on df. `measuring` means ask again; a failed df leaves sizes null. */
export async function measureOrphans(
  list: OrphanVolume[],
  { waitMs = SIZES_WAIT_MS, sizes = () => volumeSizes() }: { waitMs?: number; sizes?: () => Promise<Sizes | null> } = {},
): Promise<{ volumes: OrphanVolume[]; measuring: boolean }> {
  const result = await within<Sizes | null | typeof STILL_MEASURING>(sizes(), waitMs, STILL_MEASURING);
  if (result === STILL_MEASURING) return { volumes: list, measuring: true };
  return { volumes: list.map((v) => ({ ...v, sizeBytes: result?.get(v.name) ?? null })), measuring: false };
}

export type OrphanDeleteResult = { name: string; ok: boolean; error?: string };

/** Removes each named volume that is still an orphan right now. Never forces. */
export async function deleteOrphanVolumes(
  names: string[],
  deps: { load?: () => Promise<OrphanSnapshot>; remove?: (name: string) => Promise<void> } = {},
): Promise<OrphanDeleteResult[]> {
  const orphans = new Set(resolveOrphans(await (deps.load ?? loadOrphanSnapshot)()).map((v) => v.name));
  const remove = deps.remove ?? ((name: string) => removeVolume(name));
  const results: OrphanDeleteResult[] = [];
  for (const name of names) {
    if (!orphans.has(name)) {
      results.push({ name, ok: false, error: "No longer unused" });
      continue;
    }
    try {
      await remove(name);
      results.push({ name, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, error: /\b409\b|in use/i.test(message) ? "In use" : message });
    }
  }
  return results;
}

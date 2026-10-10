// Daily refresh of the EOL table from endoflife.date. A failed or invalid fetch keeps the last good table.

import { logger } from "@/lib/logger";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { safeFetch } from "@/lib/security/safe-fetch";
import { HttpError, retry } from "@/lib/net/retry";
import { EOL_TABLE, setActiveEolTable, type EolEngine, type EolSeries } from "./eol";

const log = logger.child("image-eol");

const API = "https://endoflife.date/api";
const SETTING_KEY = "image_eol_table";
const FETCH_TIMEOUT_MS = 10_000;
const REFRESH_MS = 24 * 60 * 60 * 1000;

const SERIES_RE = /^\d+(\.\d+)*$/;
const DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;

/** Series per engine id. Regexes stay in code; only dates are stored. */
export type StoredEol = { fetchedAt: string; engines: Record<string, EolSeries[]> };

export type ProductFetcher = (product: string) => Promise<unknown>;

/** A plausible `YYYY-MM-DD`, or null. */
function validDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = DATE_RE.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return null;
  const year = Number(match[1]);
  return year >= 2000 && year <= 2100 ? value : null;
}

/** Dated cycles from one endoflife.date payload. Throws when the payload isn't one. */
export function parseProduct(payload: unknown): EolSeries[] {
  if (!Array.isArray(payload) || payload.length === 0) throw new Error("not a list of cycles");
  const series: EolSeries[] = [];
  for (const entry of payload) {
    if (!entry || typeof entry !== "object") throw new Error("cycle is not an object");
    const { cycle, eol } = entry as { cycle?: unknown; eol?: unknown };
    if (typeof cycle !== "string" && typeof cycle !== "number") throw new Error("cycle has no name");
    // `eol: false` is still supported with no date set.
    if (typeof eol === "boolean") continue;
    const date = validDate(eol);
    if (!date) throw new Error(`cycle ${cycle} has an unreadable date`);
    const name = String(cycle);
    if (SERIES_RE.test(name)) series.push({ series: name, eol: date });
  }
  if (series.length === 0) throw new Error("no dated cycles");
  return series;
}

/** Bundled series overlaid with fetched ones. Bundled aliases such as `mongo:7` stay. */
function overlay(base: EolSeries[], fetched: EolSeries[]): EolSeries[] {
  const merged = new Map(base.map((s) => [s.series, s]));
  for (const entry of fetched) merged.set(entry.series, entry);
  return [...merged.values()];
}

/** The bundled table with stored series swapped in. Engines missing from storage keep bundled dates. */
export function tableFrom(stored: StoredEol | null): EolEngine[] {
  if (!stored) return EOL_TABLE;
  return EOL_TABLE.map((engine) => {
    const series = stored.engines[engine.id];
    return series?.length ? { ...engine, series } : engine;
  });
}

function parseStored(raw: string | null): StoredEol | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredEol;
    if (!parsed || typeof parsed.engines !== "object" || parsed.engines === null) return null;
    for (const series of Object.values(parsed.engines)) {
      if (!Array.isArray(series) || !series.every((s) => SERIES_RE.test(s?.series) && validDate(s?.eol))) {
        return null;
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

async function fetchProduct(product: string): Promise<unknown> {
  return retry(
    async ({ signal }) => {
      const res = await safeFetch(`${API}/${product}.json`, {
        headers: { accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw HttpError.fromResponse(res, `${product}: HTTP ${res.status}`);
      return res.json();
    },
    { maxAttempts: 3, budgetMs: 60_000 },
  );
}

export type EolSyncOutcome = "updated" | "partial" | "kept" | "bundled";

type Store = {
  read: () => Promise<string | null>;
  write: (value: string) => Promise<void>;
};

const settingStore: Store = {
  read: () => getSystemSettingRaw(SETTING_KEY),
  write: (value) => setSystemSetting(SETTING_KEY, value),
};

/**
 * Refreshes every engine with a product slug. Each engine that fails to fetch or validate keeps
 * its last good series, or the bundled ones with nothing stored.
 */
export async function syncEolTable(
  opts: { fetchProduct?: ProductFetcher; store?: Store; now?: () => Date } = {},
): Promise<EolSyncOutcome> {
  const fetcher = opts.fetchProduct ?? fetchProduct;
  const store = opts.store ?? settingStore;
  const lastGood = parseStored(await store.read().catch(() => null));

  const engines: Record<string, EolSeries[]> = { ...(lastGood?.engines ?? {}) };
  let refreshed = 0;
  let failed = 0;

  for (const engine of EOL_TABLE) {
    if (!engine.product) continue;
    try {
      engines[engine.id] = overlay(engine.series, parseProduct(await fetcher(engine.product)));
      refreshed++;
    } catch (err) {
      failed++;
      log.warn(`Keeping the last good EOL dates for ${engine.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (refreshed === 0) {
    setActiveEolTable(tableFrom(lastGood));
    return lastGood ? "kept" : "bundled";
  }

  const next: StoredEol = { fetchedAt: (opts.now?.() ?? new Date()).toISOString(), engines };
  setActiveEolTable(tableFrom(next));
  await store.write(JSON.stringify(next)).catch((err) => log.warn("Couldn't store the EOL table:", err));
  return failed > 0 ? "partial" : "updated";
}

/** Loads the stored table now, then refreshes it daily. */
export function startEolSync(): NodeJS.Timeout {
  const tick = () => syncEolTable().catch((err) => log.error("EOL table sync failed:", err));
  void settingStore
    .read()
    .then((raw) => setActiveEolTable(tableFrom(parseStored(raw))))
    .catch(() => {})
    .finally(tick);
  const interval = setInterval(tick, REFRESH_MS);
  interval.unref?.();
  return interval;
}

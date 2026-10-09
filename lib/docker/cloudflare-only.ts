// The built-in `cloudflare-only` middleware: an ipAllowList of Cloudflare's ranges plus VARDO_TRUSTED_PROXIES, refreshed daily.

import { isIP } from "net";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import YAML from "yaml";
import { TRAEFIK_DYNAMIC_DIR } from "@/lib/paths";
import { CLOUDFLARE_IPV4_RANGES, CLOUDFLARE_IPV6_RANGES, parseTrustedProxies, trustedProxyRanges } from "@/lib/cloudflare-ips";
import { logger } from "@/lib/logger";

const log = logger.child("cloudflare-only");

// .yaml so no app's <name>.yml can replace it.
export const CLOUDFLARE_ONLY_FILE = "vardo-cloudflare-only.yaml";

const SOURCES = {
  v4: "https://www.cloudflare.com/ips-v4",
  v6: "https://www.cloudflare.com/ips-v6",
} as const;
const FETCH_TIMEOUT_MS = 15_000;
const REFRESH_MS = 24 * 60 * 60 * 1000;
// Cloudflare publishes 15 v4 and 7 v6 ranges; far fewer means a bad response.
const MIN_RANGES = { v4: 5, v6: 3 } as const;

export type CloudflareRanges = { v4: string[]; v6: string[] };

function isCidr(value: string, family: 4 | 6): boolean {
  const [addr, prefix, extra] = value.split("/");
  if (extra !== undefined || !addr || !prefix || !/^\d{1,3}$/.test(prefix)) return false;
  return isIP(addr) === family && Number(prefix) <= (family === 4 ? 32 : 128);
}

/** One CIDR per line, nothing else. Returns the ranges, or why the list was refused. */
export function parseRangeList(body: string, family: 4 | 6): { ranges: string[] } | { error: string } {
  const ranges = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const bad = ranges.find((r) => !isCidr(r, family));
  if (bad) return { error: `"${bad.slice(0, 60)}" is not an IPv${family} CIDR` };
  const min = family === 4 ? MIN_RANGES.v4 : MIN_RANGES.v6;
  if (ranges.length < min) return { error: `only ${ranges.length} IPv${family} ranges` };
  return { ranges: [...new Set(ranges)] };
}

const EXTRAS_PREFIX = "# VARDO_TRUSTED_PROXIES: ";

function allowed(ranges: CloudflareRanges, extras: readonly string[]): string[] {
  return [...new Set([...ranges.v4, ...ranges.v6, ...extras])];
}

/** Extras are valid CIDRs from trustedProxyRanges, recorded in a comment so a failed fetch can tell them apart. */
export function renderCloudflareOnly(ranges: CloudflareRanges, extras: readonly string[] = []): string {
  const config = {
    http: {
      middlewares: {
        "cloudflare-only": { ipAllowList: { sourceRange: allowed(ranges, extras) } },
      },
    },
  };
  const header = "# Written by Vardo from cloudflare.com/ips and VARDO_TRUSTED_PROXIES. Do not edit.\n";
  const extrasLine = extras.length > 0 ? `${EXTRAS_PREFIX}${extras.join(",")}\n` : "";
  return `${header}${extrasLine}${YAML.stringify(config)}`;
}

/** The VARDO_TRUSTED_PROXIES entries a rendered file was written with. */
export function readRenderedExtras(content: string): string[] {
  const line = content.split("\n").find((l) => l.startsWith(EXTRAS_PREFIX));
  return line ? parseTrustedProxies(line.slice(EXTRAS_PREFIX.length)).ranges : [];
}

/** A rendered file's Cloudflare ranges, without its extras, or null when it isn't one Vardo would write. */
function renderedCloudflareRanges(content: string): string[] | null {
  const all = readRenderedRanges(content);
  if (!all) return null;
  const extras = new Set(readRenderedExtras(content));
  const cloudflare = all.filter((r) => !extras.has(r));
  return cloudflare.length > 0 ? cloudflare : null;
}

/** The ranges a rendered file allows, or null when it isn't one Vardo would write. */
export function readRenderedRanges(content: string): string[] | null {
  try {
    const parsed = YAML.parse(content) as { http?: { middlewares?: Record<string, { ipAllowList?: { sourceRange?: unknown } }> } };
    const range = parsed?.http?.middlewares?.["cloudflare-only"]?.ipAllowList?.sourceRange;
    if (!Array.isArray(range) || range.length === 0) return null;
    return range.every((r) => typeof r === "string" && (isCidr(r, 4) || isCidr(r, 6))) ? (range as string[]) : null;
  } catch {
    return null;
  }
}

async function fetchList(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

export async function fetchCloudflareRanges(fetcher: (url: string) => Promise<string> = fetchList): Promise<CloudflareRanges> {
  const [v4Body, v6Body] = await Promise.all([fetcher(SOURCES.v4), fetcher(SOURCES.v6)]);
  const v4 = parseRangeList(v4Body, 4);
  if ("error" in v4) throw new Error(`ips-v4: ${v4.error}`);
  const v6 = parseRangeList(v6Body, 6);
  if ("error" in v6) throw new Error(`ips-v6: ${v6.error}`);
  return { v4: v4.ranges, v6: v6.ranges };
}

export const BUNDLED_RANGES: CloudflareRanges = { v4: CLOUDFLARE_IPV4_RANGES, v6: CLOUDFLARE_IPV6_RANGES };

async function readCurrent(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Refreshes the middleware file from cloudflare.com and VARDO_TRUSTED_PROXIES. A failed fetch or a list
 * that doesn't validate keeps the last good Cloudflare ranges; with no file yet, the bundled ranges are written.
 */
export async function syncCloudflareOnly(opts: {
  dir?: string;
  fetchRanges?: () => Promise<CloudflareRanges>;
  env?: Record<string, string | undefined>;
} = {}): Promise<"updated" | "unchanged" | "kept" | "bundled" | "skipped"> {
  const dir = opts.dir ?? TRAEFIK_DYNAMIC_DIR;
  const path = join(dir, CLOUDFLARE_ONLY_FILE);
  const current = await readCurrent(path);
  const lastGood = current !== null ? renderedCloudflareRanges(current) : null;
  const extras = trustedProxyRanges(opts.env);

  let ranges: CloudflareRanges;
  let outcome: "updated" | "bundled" | "kept";
  try {
    ranges = await (opts.fetchRanges ?? fetchCloudflareRanges)();
    outcome = "updated";
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (lastGood) {
      log.warn(`Keeping the last good Cloudflare ranges: ${reason}`);
      ranges = { v4: lastGood.filter((r) => !r.includes(":")), v6: lastGood.filter((r) => r.includes(":")) };
      outcome = "kept";
    } else {
      log.warn(`Writing bundled Cloudflare ranges: ${reason}`);
      ranges = BUNDLED_RANGES;
      outcome = "bundled";
    }
  }

  const content = renderCloudflareOnly(ranges, extras);
  // Validate what Traefik will read before it replaces anything.
  const rendered = readRenderedRanges(content);
  if (!rendered || rendered.length !== allowed(ranges, extras).length) {
    log.error("Rendered Cloudflare middleware did not validate; keeping the current file");
    return "kept";
  }
  if (content === current) return outcome === "kept" ? "kept" : "unchanged";

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(`${path}.tmp`, content, { encoding: "utf-8", mode: 0o644 });
    await rename(`${path}.tmp`, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return "skipped";
    throw err;
  }
  log.info(`Cloudflare middleware ${outcome === "bundled" ? "written from bundled ranges" : "refreshed"} (${rendered.length} ranges)`);
  return outcome;
}

/** The Cloudflare ranges the middleware file allows, or the bundled ones without a valid file. */
export async function currentCloudflareRanges(dir: string = TRAEFIK_DYNAMIC_DIR): Promise<string[]> {
  const content = await readCurrent(join(dir, CLOUDFLARE_ONLY_FILE));
  return (content !== null && renderedCloudflareRanges(content)) || [...BUNDLED_RANGES.v4, ...BUNDLED_RANGES.v6];
}

/** Writes the middleware now, then refreshes it daily. Traefik's trusted IPs follow the same list. */
export function startCloudflareOnlySync(): void {
  const tick = () =>
    syncCloudflareOnly()
      .then(async () => {
        const { syncTraefikTrustedIps } = await import("./trusted-proxies");
        await syncTraefikTrustedIps({ ranges: await currentCloudflareRanges() });
      })
      .catch((err) => log.error("Cloudflare range sync failed:", err));
  void tick();
  setInterval(tick, REFRESH_MS).unref?.();
}

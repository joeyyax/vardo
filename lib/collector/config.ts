// Which collector Vardo reads, from env: an existing one by URL, one it provisions, or none.

import { readFile } from "node:fs/promises";

/** Where a provisioned collector answers, on the monitoring network. */
export const PROVISIONED_COLLECTOR_URL = "http://collector:9273";

/** system_settings key holding a provisioned collector's bearer token. */
export const COLLECTOR_TOKEN_KEY = "collector_token";

/** Provisioned when `VARDO_COLLECTOR_IMAGE` is unset. */
export const DEFAULT_COLLECTOR_IMAGE = "ghcr.io/joeyyax/collector:0.4.0";

export type CollectorMode =
  | { kind: "off" }
  | { kind: "url"; url: string }
  | { kind: "provisioned"; image: string; url: string };

type Env = Record<string, string | undefined>;

/** `VARDO_COLLECTOR_URL` wins; `VARDO_COLLECTOR_IMAGE=off` reads no container metrics; otherwise Vardo provisions one. */
export function collectorMode(env: Env = process.env): CollectorMode {
  const url = env.VARDO_COLLECTOR_URL?.trim();
  if (url) return { kind: "url", url: url.replace(/\/+$/, "") };
  const image = env.VARDO_COLLECTOR_IMAGE?.trim() || DEFAULT_COLLECTOR_IMAGE;
  if (image.toLowerCase() === "off") return { kind: "off" };
  return { kind: "provisioned", image, url: PROVISIONED_COLLECTOR_URL };
}

/** True when Vardo should run its own collector core service. */
export function shouldProvisionCollector(env: Env = process.env): boolean {
  return collectorMode(env).kind === "provisioned";
}

/** Bearer token for the collector, or null when it's unauthenticated. */
export async function collectorToken(mode: CollectorMode, env: Env = process.env): Promise<string | null> {
  if (mode.kind === "off") return null;
  if (mode.kind === "url") {
    if (env.VARDO_COLLECTOR_TOKEN?.trim()) return env.VARDO_COLLECTOR_TOKEN.trim();
    const file = env.VARDO_COLLECTOR_TOKEN_FILE?.trim();
    if (!file) return null;
    const token = (await readFile(file, "utf-8")).trim();
    return token || null;
  }
  const { getSystemSettingRaw } = await import("@/lib/system-settings");
  return getSystemSettingRaw(COLLECTOR_TOKEN_KEY);
}

/** `collectorToken`, cached for a minute. A failed read logs nothing and sends no token. */
export function collectorTokenSource(mode: CollectorMode, env: Env = process.env, ttlMs = 60_000): () => Promise<string | null> {
  let cached: { at: number; token: string | null } | null = null;
  return async () => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.token;
    const token = await collectorToken(mode, env).catch(() => null);
    cached = { at: Date.now(), token };
    return token;
  };
}

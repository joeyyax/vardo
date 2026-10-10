// Keeps every process's cached settings current: a vardo:config message on each write, and a reload every 60s.

import Redis from "ioredis";
import { logger } from "@/lib/logger";
import { closeOnShutdown } from "@/lib/shutdown";
import { IntervalLoop } from "@/lib/worker/interval-loop";

const log = logger.child("config-sync");

export const CONFIG_CHANNEL = "vardo:config";
const RELOAD_MS = 60_000;

/** Tells every process, this one's other bundles included, that a system setting changed. */
export async function publishConfigChange(key: string): Promise<void> {
  const { redis } = await import("@/lib/redis");
  await redis.publish(CONFIG_CHANNEL, JSON.stringify({ key }));
}

/** Drops cached settings and reloads the in-memory copies loops read synchronously. */
export async function reloadConfig(key?: string): Promise<void> {
  const { invalidateSettingsCache } = await import("@/lib/system-settings");
  invalidateSettingsCache(key);
  if (!key || key === "feature_flags") {
    const { loadFeatureFlags } = await import("@/lib/config/features");
    await loadFeatureFlags().catch((err) => log.warn("Couldn't reload feature flags:", err));
  }
  const { loadResourceSettings, RESOURCE_SETTINGS_KEY } = await import("@/lib/resources/host");
  if (!key || key === RESOURCE_SETTINGS_KEY) await loadResourceSettings();
}

function parseKey(message: string): string | undefined {
  try {
    const { key } = JSON.parse(message) as { key?: unknown };
    return typeof key === "string" ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Subscribes on a dedicated connection; a subscribed client can't run other commands. */
async function subscribe(): Promise<void> {
  const subscriber = new Redis(process.env.REDIS_URL || "redis://localhost:7200", { lazyConnect: true });
  subscriber.on("error", (err) => log.warn("Config subscriber error:", err.message));
  subscriber.on("message", (_channel, message) => {
    void reloadConfig(parseKey(message)).catch((err) => log.warn("Config reload failed:", err));
  });
  closeOnShutdown(() => subscriber.disconnect());
  await subscriber.subscribe(CONFIG_CHANNEL);
}

/** Per process: subscribes at start, then reloads every 60s in case a message was missed. */
export const configSyncLoop = new IntervalLoop({
  name: "config-sync",
  intervalMs: RELOAD_MS,
  log,
  prepare: async () => {
    await subscribe().catch((err) => log.warn("Couldn't subscribe to config changes; relying on the 60s reload:", err));
  },
  run: () => reloadConfig(),
});

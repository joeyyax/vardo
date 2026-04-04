import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:cron");

export async function registerCronPlugin(): Promise<void> {
  await registerPlugin(manifest);

  try {
    const { startCronScheduler } = await import("@/lib/cron/scheduler");
    startCronScheduler();
    log.info("Cron scheduler started");
  } catch (err) {
    log.error("Failed to start cron scheduler:", err);
  }

  log.info("Cron plugin registered");
}

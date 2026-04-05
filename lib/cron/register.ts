import { logger } from "@/lib/logger";

const log = logger.child("cron");

export async function registerCronPlugin(): Promise<void> {
  try {
    const { startCronScheduler } = await import("@/lib/cron/scheduler");
    startCronScheduler();
    log.info("Cron scheduler started");
  } catch (err) {
    log.error("Failed to start cron scheduler:", err);
  }
}

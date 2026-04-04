import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:digest");

export async function registerDigestPlugin(): Promise<void> {
  await registerPlugin(manifest);

  try {
    const { startDigestScheduler } = await import("@/lib/digest/scheduler");
    startDigestScheduler();
    log.info("Digest scheduler started");
  } catch (err) {
    log.error("Failed to start digest scheduler:", err);
  }

  log.info("Digest plugin registered");
}

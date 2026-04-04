import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:error-tracking");

export async function registerErrorTrackingPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Error tracking plugin registered");
}

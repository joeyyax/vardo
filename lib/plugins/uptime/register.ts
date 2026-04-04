import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:uptime");

export async function registerUptimePlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Uptime monitoring plugin registered");
}

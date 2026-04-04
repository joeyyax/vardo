import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:logging");

export async function registerLoggingPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Logging plugin registered");
}

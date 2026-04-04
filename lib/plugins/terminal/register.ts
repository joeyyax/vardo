import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:terminal");

export async function registerTerminalPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Terminal plugin registered");
}

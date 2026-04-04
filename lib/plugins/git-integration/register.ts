import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:git");

export async function registerGitIntegrationPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Git integration plugin registered");
}

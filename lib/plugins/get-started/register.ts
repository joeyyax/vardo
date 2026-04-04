import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:get-started");

export async function registerGetStartedPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Get Started plugin registered");
}

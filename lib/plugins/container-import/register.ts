// ---------------------------------------------------------------------------
// Container Import plugin registration
//
// Registers the container-import plugin. No additional initialization needed —
// the plugin gates access to the existing discovery and import API routes.
// ---------------------------------------------------------------------------

import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:container-import");

export async function registerContainerImportPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("Container import plugin registered");
}

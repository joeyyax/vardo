import { registerPlugin } from "@/lib/plugins/registry";
import manifest from "./manifest";
import { logger } from "@/lib/logger";

const log = logger.child("plugin:mcp");

export async function registerMcpPlugin(): Promise<void> {
  await registerPlugin(manifest);
  log.info("MCP server plugin registered");
}

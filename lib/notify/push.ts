/**
 * Push notification adapter — stub interface for ntfy integration.
 *
 * Will route through the services MCP `notify_send_push` tool or
 * direct ntfy HTTP API.
 */

export type PushOptions = {
  title: string;
  body: string;
  url?: string;
  priority?: "min" | "low" | "default" | "high" | "urgent";
  tags?: string[];
};

export async function push(_options: PushOptions): Promise<void> {
  throw new Error(
    "[notify.push] Not implemented yet. Use services MCP notify_send_push for now.",
  );
}

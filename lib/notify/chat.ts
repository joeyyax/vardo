/**
 * Chat adapter — stub interface for future Slack/Discord/webhook chat integration.
 */

export type ChatOptions = {
  channel: string;
  message: string;
  blocks?: unknown[];
};

export async function chat(_options: ChatOptions): Promise<void> {
  throw new Error("[notify.chat] Not implemented yet.");
}

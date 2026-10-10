import type { NotificationTestEvent } from "@/lib/bus/events";
import { createChannel } from "./factory";

export type TestSendResult = {
  ok: boolean;
  message: string;
  /** HTTP status from a webhook or Slack endpoint. */
  providerStatus?: number;
  providerMessageIds?: string[];
  partialFailure?: string;
};

/** Sends a labeled test notification through one channel, enabled or not, and reports what the provider said. */
export async function sendTestNotification(channel: {
  name: string;
  type: "email" | "webhook" | "slack";
  organizationId: string;
  config: unknown;
}): Promise<TestSendResult> {
  const event: NotificationTestEvent = {
    type: "notification.test",
    title: "Test notification from Vardo",
    message: `This is a test of the "${channel.name}" notification channel. No action needed.`,
    channelName: channel.name,
    organizationId: channel.organizationId,
  };

  try {
    const receipt = (await createChannel(channel).send(event)) ?? {};
    const status = receipt.providerStatus;
    if (status !== undefined && (status < 200 || status >= 300)) {
      return { ok: false, message: `The endpoint answered ${status}.`, providerStatus: status };
    }
    return {
      ok: true,
      message: receipt.partialFailure ? "Sent, but not to every recipient." : "Sent.",
      ...receipt,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

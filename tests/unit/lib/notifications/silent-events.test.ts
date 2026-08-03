// backup.progress fires once per source in a run. Delivering it to a channel
// would mean an email per volume every night, so it must never resolve a
// recipient — not even for a channel that subscribes to everything.

import { describe, it, expect } from "vitest";
import { resolveRecipients } from "@/lib/notifications/resolve-recipients";

const members = [{ userId: "user-1" }];

describe("resolveRecipients — live-UI-only events", () => {
  it("never sends backup.progress, whatever the channel type", () => {
    for (const channelType of ["email", "slack", "webhook"]) {
      expect(
        resolveRecipients("chan-1", channelType, "backup.progress", members, []).shouldSend,
      ).toBe(false);
    }
  });

  it("never sends backup.progress even when a member opted in", () => {
    const prefs = [{ channelId: "chan-1", userId: "user-1", enabled: true }];

    expect(
      resolveRecipients("chan-1", "email", "backup.progress", members, prefs).shouldSend,
    ).toBe(false);
  });

  it("still sends the terminal backup events", () => {
    expect(resolveRecipients("chan-1", "email", "backup.success", members, []).shouldSend).toBe(true);
    expect(resolveRecipients("chan-1", "email", "backup.failed", members, []).shouldSend).toBe(true);
  });
});

import { db } from "@/lib/db";
import { notificationChannels } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import type { NotificationEvent } from "./port";
import { createChannel } from "./factory";

export function notify(orgId: string, event: NotificationEvent): void {
  Promise.resolve().then(async () => {
    try {
      const channels = await db.query.notificationChannels.findMany({ where: and(eq(notificationChannels.organizationId, orgId), eq(notificationChannels.enabled, true)) });
      if (channels.length === 0) return;
      await Promise.allSettled(channels.map(async (row) => { try { await createChannel(row).send(event); } catch (err) { console.error(`[notifications] Channel "${row.name}" failed:`, err); } }));
    } catch (err) { console.error("[notifications] Dispatch error:", err); }
  });
}

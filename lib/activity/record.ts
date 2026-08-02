import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { nanoid } from "nanoid";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { familyFor, outcomeFor } from "./taxonomy";

type RecordActivityOpts = {
  organizationId: string;
  action: string;
  appId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export async function recordActivity(opts: RecordActivityOpts): Promise<void> {
  // Skip the write, not just the page — disabling activity stops the volume.
  if (!(await isFeatureEnabledAsync("activity"))) return;

  await db.insert(activities).values({
    id: nanoid(),
    organizationId: opts.organizationId,
    action: opts.action,
    appId: opts.appId ?? null,
    userId: opts.userId ?? null,
    family: familyFor(opts.action),
    outcome: outcomeFor(opts.action),
    metadata: opts.metadata ?? null,
  });
}

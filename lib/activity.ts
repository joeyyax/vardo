import { db } from "@/lib/db";
import { activities } from "@/lib/db/schema";
import { nanoid } from "nanoid";

type RecordActivityOpts = {
  organizationId: string;
  action: string;
  projectId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
};

export async function recordActivity(opts: RecordActivityOpts): Promise<void> {
  await db.insert(activities).values({
    id: nanoid(),
    organizationId: opts.organizationId,
    action: opts.action,
    projectId: opts.projectId ?? null,
    userId: opts.userId ?? null,
    metadata: opts.metadata ?? null,
  });
}

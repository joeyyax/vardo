// ---------------------------------------------------------------------------
// Toast emitter — send toasts to users via Redis Streams
//
// Three tiers:
//   temp       — auto-dismiss, no persistence (e.g. "Settings saved")
//   progress   — updates in-place via toastId, auto-dismiss on complete
//   persistent — stays until user action, backed by DB inbox
// ---------------------------------------------------------------------------

import { addToast } from "@/lib/stream/producer";
import { nanoid } from "nanoid";
import { logger } from "@/lib/logger";
import type { ToastTier } from "@/lib/stream/types";

const log = logger.child("toasts");

type EmitToastOpts = {
  userId: string;
  tier: ToastTier;
  type: string;
  title: string;
  message: string;
  /** Required for progress toasts — updates match by toastId */
  toastId?: string;
  progress?: number;
  status?: "running" | "complete" | "failed";
  /** Deep link for persistent toasts */
  actionUrl?: string;
  actionLabel?: string;
  /** Org context for persistent toasts (stored in DB inbox) */
  organizationId?: string;
};

/**
 * Emit a toast to a user. Writes to their toast stream for SSE delivery.
 * Persistent toasts are also written to the DB inbox for durability.
 */
export async function emitToast(opts: EmitToastOpts): Promise<string> {
  const toastId = opts.toastId ?? nanoid();

  // Write to Redis Stream for SSE delivery
  await addToast(opts.userId, {
    toastId,
    tier: opts.tier,
    type: opts.type,
    title: opts.title,
    message: opts.message,
    progress: opts.progress,
    status: opts.status,
    actionUrl: opts.actionUrl,
    actionLabel: opts.actionLabel,
  });

  // Persistent toasts also go to DB inbox
  if (opts.tier === "persistent") {
    try {
      const { db } = await import("@/lib/db");
      const { userNotifications } = await import("@/lib/db/schema");
      await db.insert(userNotifications).values({
        id: toastId,
        userId: opts.userId,
        organizationId: opts.organizationId ?? null,
        type: opts.type,
        title: opts.title,
        message: opts.message,
        actionUrl: opts.actionUrl ?? null,
      });
    } catch (err) {
      log.error("Failed to persist toast to DB inbox:", err);
      // Stream delivery still succeeded — don't fail the whole operation
    }
  }

  return toastId;
}

/**
 * Update a progress toast. Convenience wrapper that reuses the toastId.
 */
export async function updateProgressToast(opts: {
  userId: string;
  toastId: string;
  type: string;
  title: string;
  message: string;
  progress: number;
  status: "running" | "complete" | "failed";
}): Promise<void> {
  await emitToast({
    ...opts,
    tier: "progress",
  });
}

import { redis } from "@/lib/redis";
import { db } from "@/lib/db";
import { documents, documentRevisions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

// Lock idle timeout: 20 minutes
const LOCK_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
// Redis key TTL: 30 minutes (generous, cleaned up by heartbeat logic)
const REDIS_KEY_TTL_SECONDS = 30 * 60;

export type LockState = {
  userId: string;
  userName: string;
  lockedAt: string; // ISO
  lastActiveAt: string; // ISO
};

function lockKey(documentId: string) {
  return `doc-lock:${documentId}`;
}

export function lockRequestChannel(documentId: string) {
  return `doc-lock-request:${documentId}`;
}

/**
 * Check if a lock has expired due to inactivity.
 */
export function isLockExpired(lock: LockState): boolean {
  const lastActive = new Date(lock.lastActiveAt).getTime();
  return Date.now() - lastActive > LOCK_IDLE_TIMEOUT_MS;
}

/**
 * Read lock state from Redis, falling back to DB.
 */
export async function getLockStatus(
  documentId: string
): Promise<LockState | null> {
  // Try Redis first (fast path)
  const cached = await redis.get(lockKey(documentId));
  if (cached) {
    try {
      return JSON.parse(cached) as LockState;
    } catch {
      // Corrupted, fall through to DB
    }
  }

  // Fallback to DB
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: {
      lockedBy: true,
      lockedAt: true,
      lastActiveAt: true,
    },
  });

  if (!doc?.lockedBy || !doc.lockedAt) return null;

  // We need the user name — fetch it
  const user = await db.query.users.findFirst({
    where: eq(
      (await import("@/lib/db/schema")).users.id,
      doc.lockedBy
    ),
    columns: { name: true, email: true },
  });

  const lock: LockState = {
    userId: doc.lockedBy,
    userName: user?.name || user?.email || "Unknown",
    lockedAt: doc.lockedAt.toISOString(),
    lastActiveAt: (doc.lastActiveAt || doc.lockedAt).toISOString(),
  };

  // Re-populate Redis cache
  await redis.set(
    lockKey(documentId),
    JSON.stringify(lock),
    "EX",
    REDIS_KEY_TTL_SECONDS
  );

  return lock;
}

/**
 * Attempt to acquire the lock on a document.
 */
export async function acquireLock(
  documentId: string,
  userId: string,
  userName: string
): Promise<
  | { acquired: true }
  | { acquired: false; lock: LockState }
> {
  const existing = await getLockStatus(documentId);

  // If there's an active lock by another user, deny
  if (existing && existing.userId !== userId && !isLockExpired(existing)) {
    return { acquired: false, lock: existing };
  }

  // If locked by someone else but expired, release first (no revision — they were idle)
  if (existing && existing.userId !== userId && isLockExpired(existing)) {
    await clearLockState(documentId);
  }

  const now = new Date();
  const lock: LockState = {
    userId,
    userName,
    lockedAt: now.toISOString(),
    lastActiveAt: now.toISOString(),
  };

  // Set in Redis
  await redis.set(
    lockKey(documentId),
    JSON.stringify(lock),
    "EX",
    REDIS_KEY_TTL_SECONDS
  );

  // Set in DB (source of truth)
  await db
    .update(documents)
    .set({
      lockedBy: userId,
      lockedAt: now,
      lastActiveAt: now,
    })
    .where(eq(documents.id, documentId));

  return { acquired: true };
}

/**
 * Release the lock on a document.
 * Only the lock holder (or system) can release.
 */
export async function releaseLock(
  documentId: string,
  userId: string
): Promise<boolean> {
  const existing = await getLockStatus(documentId);
  if (!existing || existing.userId !== userId) return false;

  await clearLockState(documentId);
  return true;
}

/**
 * Update lastActiveAt (heartbeat).
 */
export async function heartbeat(
  documentId: string,
  userId: string
): Promise<boolean> {
  const existing = await getLockStatus(documentId);
  if (!existing || existing.userId !== userId) return false;

  const now = new Date();
  const updated: LockState = {
    ...existing,
    lastActiveAt: now.toISOString(),
  };

  await redis.set(
    lockKey(documentId),
    JSON.stringify(updated),
    "EX",
    REDIS_KEY_TTL_SECONDS
  );

  await db
    .update(documents)
    .set({ lastActiveAt: now })
    .where(eq(documents.id, documentId));

  return true;
}

/**
 * Snapshot current document state into a revision before transferring the lock.
 */
export async function createRevisionBeforeTransfer(
  documentId: string,
  userId: string,
  reason: "lock_transfer" | "manual" | "auto_save" = "lock_transfer"
): Promise<void> {
  const doc = await db.query.documents.findFirst({
    where: eq(documents.id, documentId),
    columns: {
      content: true,
      variableValues: true,
      title: true,
    },
  });

  if (!doc) return;

  await db.insert(documentRevisions).values({
    documentId,
    content: doc.content,
    variableValues: doc.variableValues,
    title: doc.title,
    savedBy: userId,
    reason,
  });
}

/**
 * Transfer the lock from the current holder to a new user.
 * Creates a revision of the current state before transferring.
 */
export async function transferLock(
  documentId: string,
  fromUserId: string,
  toUserId: string,
  toUserName: string
): Promise<boolean> {
  const existing = await getLockStatus(documentId);
  if (!existing || existing.userId !== fromUserId) return false;

  // Snapshot before transfer
  await createRevisionBeforeTransfer(documentId, fromUserId, "lock_transfer");

  // Clear old lock
  await clearLockState(documentId);

  // Acquire for new user
  const result = await acquireLock(documentId, toUserId, toUserName);
  return result.acquired;
}

/**
 * Publish an edit request event via Redis pub/sub.
 */
export async function publishEditRequest(
  documentId: string,
  requesterId: string,
  requesterName: string
): Promise<void> {
  const channel = lockRequestChannel(documentId);
  await redis.publish(
    channel,
    JSON.stringify({
      type: "edit_request",
      requesterId,
      requesterName,
      timestamp: new Date().toISOString(),
    })
  );
}

/**
 * Publish a lock transfer event via Redis pub/sub.
 */
export async function publishLockTransfer(
  documentId: string,
  newHolderId: string,
  newHolderName: string
): Promise<void> {
  const channel = lockRequestChannel(documentId);
  await redis.publish(
    channel,
    JSON.stringify({
      type: "lock_transferred",
      newHolderId,
      newHolderName,
      timestamp: new Date().toISOString(),
    })
  );
}

// Internal helper to clear lock state from both Redis and DB
async function clearLockState(documentId: string): Promise<void> {
  await redis.del(lockKey(documentId));
  await db
    .update(documents)
    .set({
      lockedBy: null,
      lockedAt: null,
      lastActiveAt: null,
    })
    .where(eq(documents.id, documentId));
}

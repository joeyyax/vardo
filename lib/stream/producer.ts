// ---------------------------------------------------------------------------
// Redis Streams producer — write events to streams
// ---------------------------------------------------------------------------

import { redis } from "@/lib/redis";
import { eventStream, deployStream, toastStream } from "./keys";
import type { ToastEvent } from "./types";
import type { BusEvent } from "@/lib/bus/events";
import { getStreamMaxLen } from "./config";

/** XADD with MAXLEN trim, returns the entry ID. */
async function xadd(key: string, maxLen: number, ...fields: string[]): Promise<string> {
  const id = await redis.xadd(key, "MAXLEN", "~", String(maxLen), "*", ...fields);
  if (!id) throw new Error(`XADD returned null for ${key}`);
  return id;
}

/**
 * Add a typed org event to the event stream.
 * Returns the stream entry ID.
 */
export async function addEvent(orgId: string, event: BusEvent): Promise<string> {
  const maxLen = await getStreamMaxLen();
  return xadd(eventStream(orgId), maxLen,
    "type", event.type,
    "payload", JSON.stringify(event),
    "ts", String(Date.now()),
  );
}

/**
 * Add a deploy log line to a deploy's stream.
 * Returns the stream entry ID.
 */
export async function addDeployLog(
  deployId: string,
  entry: { line: string; stage: string; status: string },
): Promise<string> {
  const maxLen = await getStreamMaxLen();
  return xadd(deployStream(deployId), maxLen,
    "line", entry.line,
    "stage", entry.stage,
    "status", entry.status,
    "ts", String(Date.now()),
  );
}

/**
 * Add a toast event to a user's toast stream.
 * Returns the stream entry ID.
 */
export async function addToast(userId: string, toast: ToastEvent): Promise<string> {
  const maxLen = await getStreamMaxLen();
  const fields: string[] = [
    "toastId", toast.toastId,
    "tier", toast.tier,
    "type", toast.type,
    "title", toast.title,
    "message", toast.message,
    "ts", String(Date.now()),
  ];

  if (toast.progress != null) fields.push("progress", String(toast.progress));
  if (toast.status) fields.push("status", toast.status);
  if (toast.actionUrl) fields.push("actionUrl", toast.actionUrl);
  if (toast.actionLabel) fields.push("actionLabel", toast.actionLabel);

  return xadd(toastStream(userId), maxLen, ...fields);
}

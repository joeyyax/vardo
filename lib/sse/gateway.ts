// ---------------------------------------------------------------------------
// Unified SSE Gateway
//
// Multiplexes multiple Redis Streams into a single SSE connection:
//   - Org events (deploy status, backup status, system alerts)
//   - Deploy logs (per-deploy, when deployId is provided)
//   - User toasts (per-user, always)
//
// Metrics stay on their existing RedisTimeSeries path and are NOT
// multiplexed here — they have different cadence and data shape.
// ---------------------------------------------------------------------------

import { readStream } from "@/lib/stream/consumer";
import { eventStream, deployStream, toastStream } from "@/lib/stream/keys";
import type { StreamEntry } from "@/lib/stream/types";
import { logger } from "@/lib/logger";

const log = logger.child("sse-gateway");

export type GatewayOpts = {
  orgId: string;
  userId: string;
  /** Subscribe to a specific deploy's log stream */
  deployId?: string;
  /** Resume from last seen event IDs (for reconnection) */
  lastEventId?: string;
  lastDeployId?: string;
  lastToastId?: string;
  /** Abort signal — stops all readers when the client disconnects */
  signal: AbortSignal;
};

type SendFn = (event: string, data: unknown) => void;

/**
 * Start reading from all relevant streams and dispatch events via `send`.
 *
 * Each stream reader runs as an independent async loop. All stop
 * when the signal aborts (client disconnect, timeout, etc.).
 */
export function startGateway(opts: GatewayOpts, send: SendFn): void {
  // Org events — deploy status, backup status, system alerts
  readAndDispatch(
    eventStream(opts.orgId),
    opts.lastEventId,
    opts.signal,
    (entry) => {
      const payload = entry.fields.payload
        ? JSON.parse(entry.fields.payload)
        : entry.fields;
      send("event", { ...payload, streamId: entry.id });
    },
  );

  // User toasts — temp, progress, persistent
  readAndDispatch(
    toastStream(opts.userId),
    opts.lastToastId,
    opts.signal,
    (entry) => {
      send("toast", { ...entry.fields, streamId: entry.id });
    },
  );

  // Deploy logs — only if a deployId is provided
  if (opts.deployId) {
    readAndDispatch(
      deployStream(opts.deployId),
      opts.lastDeployId,
      opts.signal,
      (entry) => {
        const { fields } = entry;
        if (fields.line?.startsWith("[stage]")) {
          send("deploy-stage", {
            deployId: opts.deployId,
            stage: fields.stage,
            status: fields.status,
            streamId: entry.id,
          });
        } else {
          send("deploy-log", {
            deployId: opts.deployId,
            line: fields.line,
            stage: fields.stage,
            streamId: entry.id,
          });
        }
      },
    );
  }
}

/** Read a stream and dispatch entries via a callback. Runs until signal aborts. */
async function readAndDispatch(
  key: string,
  fromId: string | undefined,
  signal: AbortSignal,
  dispatch: (entry: StreamEntry) => void,
): Promise<void> {
  try {
    for await (const entry of readStream(key, { fromId, signal })) {
      try {
        dispatch(entry);
      } catch (err) {
        log.warn(`Failed to dispatch entry from ${key}:`, err);
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      log.error(`Stream reader error on ${key}:`, err);
    }
  }
}

// Multiplexes org events, user toasts and deploy logs from Redis Streams into one SSE connection.
// Metrics aren't multiplexed here.

import { readStream } from "@/lib/stream/consumer";
import { eventStream, deployStream, toastStream } from "@/lib/stream/keys";
import type { StreamEntry } from "@/lib/stream/types";
import { logger } from "@/lib/logger";

const log = logger.child("sse-gateway");

export type GatewayOpts = {
  orgId: string;
  userId: string;
  /** Subscribe to this deploy's log stream. */
  deployId?: string;
  /** Last seen event IDs, for reconnection. */
  lastEventId?: string;
  lastDeployId?: string;
  lastToastId?: string;
  /** Stops all readers on client disconnect. */
  signal: AbortSignal;
};

type SendFn = (event: string, data: unknown) => void;

/** Read every relevant stream and dispatch events via `send` until the signal aborts. */
export function startGateway(opts: GatewayOpts, send: SendFn): void {
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

  readAndDispatch(
    toastStream(opts.userId),
    opts.lastToastId,
    opts.signal,
    (entry) => {
      send("toast", { ...entry.fields, streamId: entry.id });
    },
  );

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

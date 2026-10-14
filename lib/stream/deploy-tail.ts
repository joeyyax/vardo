// Follows one deployment from queued to finished: why it waits, its Redis stream, then its terminal row.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deployments } from "@/lib/db/schema";
import { isTerminalStageEvent } from "@/lib/docker/deploy-logger";
import { logger } from "@/lib/logger";
import { readStream } from "./consumer";
import { deployStream } from "./keys";

const log = logger.child("deploy-tail");

const TERMINAL = new Set(["success", "failed", "cancelled", "rolled_back", "superseded"]);

export type TailHandlers = {
  onLog: (line: string, meta: { streamId: string; stage?: string }) => void;
  onStage: (stage: string, status: string, meta: { streamId: string }) => void;
  /** Why the deploy hasn't started, each time that changes. */
  onWaiting?: (message: string) => void;
  /** The row went queued or running, including a requeue after its executor stopped. */
  onStatus?: (status: "queued" | "running") => void;
};

export type TailOpts = {
  signal?: AbortSignal;
  /** Resume after this stream id. */
  fromId?: string;
  pollMs?: number;
  /** Stands in for the queue notice in tests. */
  notice?: (id: string) => Promise<string>;
};

export type TailedDeployment = {
  deploymentId: string;
  status: string;
  success: boolean;
  durationMs: number;
  log: string;
  error?: string;
  postDeployError?: string;
};

type Row = { status: string; log: string | null; durationMs: number | null; postDeployError: string | null };

async function readRow(id: string): Promise<Row | null> {
  const [row] = await db
    .select({ status: deployments.status, log: deployments.log, durationMs: deployments.durationMs, postDeployError: deployments.postDeployError })
    .from(deployments)
    .where(eq(deployments.id, id));
  return row ?? null;
}

/** The failure a deploy logged last, for callers that report it. */
export function failureFromLog(text: string | null): string | undefined {
  const lines = (text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/\[deploy\] ERROR: (.*)$/) ?? lines[i].match(/\[(?:CANCELLED|TIMEOUT)\] (.*)$/);
    if (m) return m[1];
  }
  return undefined;
}

/** Shapes a finished row for callers that used to get a DeployResult. */
export function tailed(id: string, row: Row): TailedDeployment {
  return {
    deploymentId: id,
    status: row.status,
    success: row.status === "success",
    durationMs: row.durationMs ?? 0,
    log: row.log ?? "",
    error: row.status === "success" ? undefined : failureFromLog(row.log),
    postDeployError: row.postDeployError ?? undefined,
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Tails a deployment until its row is terminal, or the signal aborts. A terminal stage event ends the tail
 * only once the row agrees, so a requeued deploy keeps streaming its next attempt.
 */
export async function tailDeployment(id: string, handlers: TailHandlers, opts: TailOpts = {}): Promise<TailedDeployment | null> {
  const pollMs = opts.pollMs ?? 1_000;
  const notice = opts.notice ?? (async (deploymentId: string) => (await import("@/lib/deploy/waiting")).queuedNotice(deploymentId));
  let lastNotice: string | null = null;
  let lastStatus: string | null = null;
  const noteStatus = (status: string) => {
    if (status === lastStatus || (status !== "queued" && status !== "running")) return;
    lastStatus = status;
    handlers.onStatus?.(status as "queued" | "running");
  };

  const waitWhileQueued = async (): Promise<Row | null> => {
    for (;;) {
      if (opts.signal?.aborted) return null;
      const row = await readRow(id);
      if (row) noteStatus(row.status);
      if (!row || row.status !== "queued") return row;
      const message = await notice(id).catch(() => null);
      if (message && message !== lastNotice) {
        lastNotice = message;
        handlers.onWaiting?.(message);
      }
      await sleep(pollMs, opts.signal);
    }
  };

  let row = await waitWhileQueued();
  if (!row) return null;

  const reader = new AbortController();
  const stop = () => reader.abort();
  opts.signal?.addEventListener("abort", stop, { once: true });

  // Ends the read once the row is terminal, after the last entries land.
  let finished: Row | null = TERMINAL.has(row.status) ? row : null;
  const watch = (async () => {
    while (!reader.signal.aborted) {
      await sleep(pollMs * 2, reader.signal);
      if (reader.signal.aborted) return;
      const current = await readRow(id).catch(() => null);
      if (!current) continue;
      noteStatus(current.status);
      if (TERMINAL.has(current.status)) {
        finished = current;
        await sleep(pollMs, reader.signal);
        stop();
        return;
      }
      if (current.status === "queued") {
        const message = await notice(id).catch(() => null);
        if (message && message !== lastNotice) {
          lastNotice = message;
          handlers.onWaiting?.(message);
        }
      }
    }
  })();

  try {
    for await (const entry of readStream(deployStream(id), { fromId: opts.fromId ?? "0-0", signal: reader.signal, blockMs: 1000 })) {
      const { fields } = entry;
      if (fields.line?.startsWith("[stage]")) {
        handlers.onStage(fields.stage, fields.status, { streamId: entry.id });
        if (isTerminalStageEvent(fields.stage, fields.status)) {
          const current = await readRow(id).catch(() => null);
          if (current && TERMINAL.has(current.status)) {
            finished = current;
            break;
          }
        }
      } else {
        handlers.onLog(fields.line, { streamId: entry.id, stage: fields.stage });
      }
    }
  } catch (err) {
    if (!reader.signal.aborted) log.warn(`Tail of ${id} stopped:`, err);
  } finally {
    stop();
    opts.signal?.removeEventListener("abort", stop);
    await watch.catch(() => {});
  }

  if (opts.signal?.aborted && !finished) return null;
  row = finished ?? (await readRow(id));
  return row ? tailed(id, row) : null;
}

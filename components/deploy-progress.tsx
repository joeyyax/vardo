"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DEPLOY_STAGE_KEYS, STAGE_LABELS } from "@/lib/ui/deploy-stage";
import { applyWait, deployClockOf, NO_WAIT, parseWaitEvent, waitLabel, type WaitState } from "@/lib/ui/deploy-wait";
import { quietLinkClass } from "@/components/entity-link";
import { appHref, deployHref } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";

type StageStatus = "running" | "success" | "failed" | "skipped";

export type DeployStream = { stages: Record<string, StageStatus>; wait: WaitState };

/** Phases and waits of an app's deploy, from its log stream. Replays from the start on connect. */
export function useDeployStream(orgId: string, appId: string, { deploymentId, enabled = true }: { deploymentId?: string; enabled?: boolean } = {}) {
  const key = `${appId}:${deploymentId ?? ""}`;
  const [stream, setStream] = useState<DeployStream & { key: string }>({ key, stages: {}, wait: NO_WAIT });
  if (stream.key !== key) setStream({ key, stages: {}, wait: NO_WAIT });

  useEffect(() => {
    if (!enabled) return;
    const query = deploymentId ? `?deploymentId=${encodeURIComponent(deploymentId)}` : "";
    const es = new EventSource(`/api/v1/organizations/${orgId}/apps/${appId}/deploy/stream${query}`);
    es.addEventListener("stage", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { stage?: string; status?: StageStatus };
        if (data.stage && data.status) setStream((s) => ({ ...s, stages: { ...s.stages, [data.stage!]: data.status! } }));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("wait", (event) => {
      try {
        const data = parseWaitEvent(JSON.parse((event as MessageEvent).data));
        if (data) setStream((s) => ({ ...s, wait: applyWait(s.wait, data) }));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("done", () => es.close());
    es.onerror = () => es.close();
    return () => es.close();
  }, [orgId, appId, deploymentId, enabled]);

  return stream;
}

/** The clock, ticking. Null until mounted so server and client render alike. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

/** Live phases of one deploy, a bar and the time left judged by the last good deploy. */
export function DeployProgress({
  stream,
  appName,
  deploymentId,
  startedAt,
  status,
  typicalMs,
}: {
  stream: DeployStream;
  appName: string;
  /** The running deploy, so the link opens it. */
  deploymentId?: string;
  startedAt: Date | string;
  /** The deployment row's status; `queued` reads as waiting until the stream says otherwise. */
  status?: string;
  /** Run time of the last successful deploy. Null when there is none. */
  typicalMs: number | null;
}) {
  const { stages } = stream;
  const now = useNow(1000);
  const clock = now === null ? null : deployClockOf(stream, { startedAt, status, now });
  const wait = clock?.wait ?? null;
  const working = clock?.workingMs ?? 0;
  const keys = DEPLOY_STAGE_KEYS.filter((k) => k !== "cleanup" && stages[k] !== "skipped");
  const current = keys.findIndex((k) => stages[k] === "running" || stages[k] === "failed");
  const share = typicalMs ? Math.min(0.97, working / typicalMs) : null;

  return (
    <div className="grid gap-2">
      <ol className="flex flex-wrap gap-1.5" aria-label="Phases">
        {keys.map((k, i) => {
          const state =
            stages[k] === "success" ? "done" : i === current ? (stages[k] === "failed" ? "failed" : wait ? "held" : "now") : "todo";
          return (
            <li
              key={k}
              aria-current={state === "now" ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground/70",
                i > 0 && "before:mr-0.5 before:w-3.5 before:border-t before:border-border",
                (state === "done" || state === "held") && "text-muted-foreground",
                state === "now" && "font-semibold text-status-info",
                state === "failed" && "font-semibold text-status-error",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]",
                  state === "done" && "bg-status-success shadow-none",
                  (state === "now" || state === "held") && "shadow-[inset_0_0_0_2px_currentColor]",
                  state === "now" && "motion-safe:animate-pulse",
                  state === "failed" && "bg-status-error shadow-none",
                )}
              />
              {STAGE_LABELS[k]}
              <span className="sr-only">{state === "done" ? ", done" : state === "now" ? ", in progress" : state === "held" ? ", waiting" : ""}</span>
            </li>
          );
        })}
      </ol>
      {share !== null && !(wait && working === 0) && (
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-accent">
          <i
            className={cn(
              "block h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              wait ? "bg-muted-foreground/40" : "bg-status-info",
            )}
            style={{ width: `${(share * 100).toFixed(1)}%` }}
          />
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]">
        <span>
          {clock === null ? null : wait ? (
            waitLabel(wait.reason, wait.ahead)
          ) : typicalMs === null ? (
            "No earlier deploy to judge by"
          ) : working < typicalMs ? (
            <>
              About <b className="font-semibold tabular-nums">{fmt(typicalMs - working)}</b> left
            </>
          ) : (
            "Taking longer than last time"
          )}
        </span>
        {clock !== null && (
          <span className="text-muted-foreground/70 tabular-nums">
            {wait ? (
              <>
                waiting {fmt(Math.min(now! - wait.since, clock.waitedMs))}
                {working > 0 && ` · ran ${fmt(working)}`}
              </>
            ) : (
              <>
                {typicalMs !== null && `last deploy took ${fmt(typicalMs)} · `}running {fmt(working)}
                {clock.waitedMs >= 1000 && ` · waited ${fmt(clock.waitedMs)}`}
              </>
            )}
          </span>
        )}
      </div>
      <Link
        href={deploymentId ? deployHref(appName, deploymentId) : appHref(appName, "deployments")}
        className={cn(quietLinkClass, "w-fit text-[13px]")}
      >
        Stream logs →
      </Link>
    </div>
  );
}

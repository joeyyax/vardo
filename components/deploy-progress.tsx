"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DEPLOY_STAGE_KEYS, STAGE_LABELS } from "@/lib/ui/deploy-stage";
import { quietLinkClass } from "@/components/entity-link";
import { appHref, deployHref } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";

type StageStatus = "running" | "success" | "failed" | "skipped";

/** Phases of an app's running deploy, from its log stream. Replays from the start on connect. */
export function useDeployStages(orgId: string, appId: string, enabled = true) {
  const [stages, setStages] = useState<Record<string, StageStatus>>({});

  useEffect(() => {
    if (!enabled) return;
    const es = new EventSource(`/api/v1/organizations/${orgId}/apps/${appId}/deploy/stream`);
    es.addEventListener("stage", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { stage?: string; status?: StageStatus };
        if (data.stage && data.status) setStages((s) => ({ ...s, [data.stage!]: data.status! }));
      } catch {
        /* malformed event */
      }
    });
    es.addEventListener("done", () => es.close());
    es.onerror = () => es.close();
    return () => es.close();
  }, [orgId, appId, enabled]);

  return stages;
}

function useNow(intervalMs: number) {
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
  orgId,
  appId,
  appName,
  deploymentId,
  startedAt,
  typicalMs,
}: {
  orgId: string;
  appId: string;
  appName: string;
  /** The running deploy, so the link opens it. */
  deploymentId?: string;
  startedAt: Date | string;
  /** End-to-end time of the last successful deploy. Null when there is none. */
  typicalMs: number | null;
}) {
  const stages = useDeployStages(orgId, appId);
  const now = useNow(1000);
  const keys = DEPLOY_STAGE_KEYS.filter((k) => k !== "cleanup" && stages[k] !== "skipped");
  const current = keys.findIndex((k) => stages[k] === "running" || stages[k] === "failed");
  const elapsed = now === null ? 0 : now - new Date(startedAt).getTime();
  const share = typicalMs ? Math.min(0.97, elapsed / typicalMs) : null;

  return (
    <div className="grid gap-2">
      <ol className="flex flex-wrap gap-1.5" aria-label="Phases">
        {keys.map((k, i) => {
          const state = stages[k] === "success" ? "done" : i === current ? (stages[k] === "failed" ? "failed" : "now") : "todo";
          return (
            <li
              key={k}
              aria-current={state === "now" ? "step" : undefined}
              className={cn(
                "inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground/70",
                i > 0 && "before:mr-0.5 before:w-3.5 before:border-t before:border-border",
                state === "done" && "text-muted-foreground",
                state === "now" && "font-semibold text-status-info",
                state === "failed" && "font-semibold text-status-error",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-2.5 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_currentColor]",
                  state === "done" && "bg-status-success shadow-none",
                  state === "now" && "shadow-[inset_0_0_0_2px_currentColor] motion-safe:animate-pulse",
                  state === "failed" && "bg-status-error shadow-none",
                )}
              />
              {STAGE_LABELS[k]}
              <span className="sr-only">{state === "done" ? ", done" : state === "now" ? ", in progress" : ""}</span>
            </li>
          );
        })}
      </ol>
      {share !== null && (
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-accent">
          <i
            className="block h-full rounded-full bg-status-info transition-[width] duration-1000 ease-linear motion-reduce:transition-none"
            style={{ width: `${(share * 100).toFixed(1)}%` }}
          />
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]">
        <span>
          {typicalMs === null || now === null ? (
            "No earlier deploy to judge by"
          ) : elapsed < typicalMs ? (
            <>
              About <b className="font-semibold tabular-nums">{fmt(typicalMs - elapsed)}</b> left
            </>
          ) : (
            "Taking longer than last time"
          )}
        </span>
        {now !== null && (
          <span className="text-muted-foreground/70">
            {typicalMs !== null && `last deploy took ${fmt(typicalMs)} · `}started {fmt(elapsed)} ago
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

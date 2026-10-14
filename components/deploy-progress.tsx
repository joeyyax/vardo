"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { DEPLOY_STAGE_KEYS, STAGE_LABELS } from "@/lib/ui/deploy-stage";
import {
  applyWait,
  deployCardText,
  deployClockOf,
  deployView,
  NO_WAIT,
  parseWaitEvent,
  queuedStep,
  type DeployView,
  type WaitState,
} from "@/lib/ui/deploy-wait";
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

export type StripStep = { key: string; label: string; state: "done" | "held" | "now" | "failed" | "todo" };

/** Queued, then the deploy phases, with the held one marked. */
export function deploySteps(view: DeployView, stages: Record<string, string>, keys: string[]): StripStep[] {
  const started = Object.keys(stages).length > 0;
  const first = queuedStep(view, started);
  const current = keys.findIndex((k) => stages[k] === "running" || stages[k] === "failed");
  return [
    { key: "queued", label: first.label, state: first.state },
    ...keys.map((k, i): StripStep => ({
      key: k,
      label: STAGE_LABELS[k],
      state:
        stages[k] === "success"
          ? "done"
          : i === current
            ? stages[k] === "failed"
              ? "failed"
              : view.held === k
                ? "held"
                : "now"
            : "todo",
    })),
  ];
}

/** Live phases of one deploy, a bar and the time left judged by the last good deploy. */
export function DeployProgress({
  stream,
  appName,
  deploymentId,
  startedAt,
  status,
  preparing = false,
  typicalMs,
}: {
  stream: DeployStream;
  appName: string;
  /** The running deploy, so the link opens it. */
  deploymentId?: string;
  startedAt: Date | string;
  /** The deployment row's status; `queued` reads as queued until the stream says otherwise. */
  status?: string;
  /** Created but not released to the queue yet. */
  preparing?: boolean;
  /** Run time of the last successful deploy. Null when there is none. */
  typicalMs: number | null;
}) {
  const { stages } = stream;
  const now = useNow(1000);
  const clock = now === null ? null : deployClockOf(stream, { startedAt, status, now });
  const started = Object.keys(stages).length > 0;
  const view = deployView({ queued: status === "queued" && !started, preparing, wait: clock?.wait ?? null, started });
  const text = clock && now !== null ? deployCardText(view, clock, { now, typicalMs, started }) : null;
  const steps = deploySteps(view, stages, DEPLOY_STAGE_KEYS.filter((k) => k !== "cleanup" && stages[k] !== "skipped"));
  const share = typicalMs && clock ? Math.min(0.97, clock.workingMs / typicalMs) : null;

  return (
    <div className="grid gap-2">
      <ol className="flex flex-wrap gap-1.5" aria-label="Phases">
        {steps.map(({ key, label, state }, i) => (
          <li
            key={key}
            aria-current={state === "now" ? "step" : undefined}
            className={cn(
              "inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground/70",
              i > 0 && "before:mr-0.5 before:w-3.5 before:border-t before:border-border",
              state === "done" && "text-muted-foreground",
              state === "held" && (view.tone === "warn" ? "font-semibold text-status-warning" : "font-semibold text-foreground"),
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
            <span title={state === "held" ? view.why : undefined}>{label}</span>
            <span className="sr-only">{state === "done" ? ", done" : state === "now" ? ", in progress" : state === "held" ? ", queued" : ""}</span>
          </li>
        ))}
      </ol>
      {share !== null && started && (
        <div aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-accent">
          <i
            className={cn(
              "block h-full rounded-full transition-[width] duration-1000 ease-linear motion-reduce:transition-none",
              view.tone === "info" ? "bg-status-info" : "bg-muted-foreground/40",
            )}
            style={{ width: `${(share * 100).toFixed(1)}%` }}
          />
        </div>
      )}
      {text && (
        <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-[13px]">
          <span className="tabular-nums" title={view.why}>
            {text.line}
          </span>
          {text.meta && <span className="text-muted-foreground/70 tabular-nums">{text.meta}</span>}
        </div>
      )}
      <Link
        href={deploymentId ? deployHref(appName, deploymentId) : appHref(appName, "deployments")}
        className={cn(quietLinkClass, "w-fit text-[13px]")}
      >
        Stream logs →
      </Link>
    </div>
  );
}

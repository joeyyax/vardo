"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import type { ActivityItem, PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import type { Lane } from "./geometry";
import { PipelineJobs } from "./pipeline-jobs";
import { PipelineLoops } from "./pipeline-loops";
import { PipelineMap, usePipelineLanes } from "./pipeline-map";

const SNAPSHOT_URL = "/api/v1/admin/pipeline";
const STREAM_URL = "/api/v1/admin/pipeline/stream";

type Received = { snapshot: PipelineSnapshot; offset: number };

/** The first snapshot over fetch, then every change over the stream. Reconnects with backoff. */
function usePipeline(): { received: Received | null; live: boolean } {
  const [received, setReceived] = useState<Received | null>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let disposed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = 1000;
    let warned = false;
    const take = (snapshot: PipelineSnapshot) => {
      if (!disposed) setReceived({ snapshot, offset: snapshot.at - Date.now() });
    };

    fetch(SNAPSHOT_URL)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        take((await res.json()) as PipelineSnapshot);
      })
      .catch(() => {
        if (!disposed) toast.error("Couldn't load the pipeline");
      });

    const connect = () => {
      if (disposed) return;
      es = new EventSource(STREAM_URL);
      es.addEventListener("open", () => {
        delay = 1000;
        setLive(true);
      });
      es.addEventListener("snapshot", (event) => {
        try {
          take(JSON.parse((event as MessageEvent).data) as PipelineSnapshot);
        } catch {
          /* malformed event */
        }
      });
      es.addEventListener("error", () => {
        setLive(false);
        es?.close();
        if (disposed) return;
        if (!warned && delay >= 8000) {
          warned = true;
          toast.error("Lost the live pipeline stream; retrying");
        }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      });
    };
    connect();

    return () => {
      disposed = true;
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);

  return { received, live };
}

/** Server time, ticking each second. */
function useNow(offset: number): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return clock + offset;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function Dot({ remote }: { remote: boolean }) {
  return <span aria-hidden className={cn("inline-block size-2.5 shrink-0 rounded-full", remote ? "bg-status-success" : "bg-foreground")} />;
}

function BuiltOn({ deploy, lane, instanceName }: { deploy: PipelineDeploy; lane: Lane | undefined; instanceName: string }) {
  if (deploy.stop === "rolledBack") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="inline-block size-2.5 rounded-full bg-status-error" />
        Rolled back
      </span>
    );
  }
  if (!deploy.builder || !deploy.builderName) return <span className="text-muted-foreground">Not yet</span>;
  const remote = deploy.builder !== "local";
  return (
    <span className="inline-flex items-center gap-1.5">
      <Dot remote={remote} />
      {deploy.builderName}
      {lane ? `, slot ${lane.index + 1}` : ""}
      {deploy.fellBack && !remote ? ` (after a build target)` : ""}
      {deploy.fellBack && remote ? ` (fell back to ${instanceName})` : ""}
    </span>
  );
}

function InFlight({ snapshot, now, lanes }: { snapshot: PipelineSnapshot; now: number; lanes: Map<string, Lane> }) {
  const rows = snapshot.deploys.filter((d) => !d.gone);
  const queued = rows.filter((d) => d.stop === "queue").length;
  return (
    <Card variant="surface" className="min-w-0 p-4 sm:p-5">
      <h2 className="type-h4">In flight</h2>
      <div className="mt-2 mb-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs">
        {snapshot.builders.map((b) => (
          <span key={b.id} className="inline-flex items-center gap-1.5">
            <Dot remote={b.id !== "local"} />
            {b.name}
            <b className="font-semibold">{b.online === false ? "offline" : `${b.holders.length}/${b.slots}`}</b>
          </span>
        ))}
        <span>
          Deploy slots <b className="font-semibold">{snapshot.deploySlots.busy}/{snapshot.deploySlots.total}</b>
        </span>
        <span>
          Queued <b className="font-semibold">{queued}</b>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left font-mono text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-2 py-1.5 font-medium">Deploy</th>
              <th className="px-2 py-1.5 font-medium">Built on</th>
              <th className="px-2 py-1.5 font-medium">Now</th>
              <th className="px-2 py-1.5 text-right font-medium">Stage</th>
              <th className="px-2 py-1.5 text-right font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-2 py-4 text-muted-foreground">
                  Nothing in flight. Deploys show here from the moment they&apos;re queued.
                </td>
              </tr>
            ) : (
              rows.map((d) => (
                <tr key={d.id} className="border-b last:border-b-0">
                  <td className="whitespace-nowrap px-2 py-1.5">{d.appName}</td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <BuiltOn deploy={d} lane={lanes.get(d.id)} instanceName={snapshot.instanceName} />
                  </td>
                  <td
                    className={cn(
                      "whitespace-nowrap px-2 py-1.5",
                      d.waiting && "text-status-warning",
                      (d.failed || d.stop === "rolledBack") && "text-status-error",
                    )}
                  >
                    {d.label}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{clock((d.finishedAt ?? now) - d.stageSince)}</td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums">{clock((d.finishedAt ?? now) - d.queuedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const TONE: Record<ActivityItem["tone"], string> = {
  default: "",
  success: "",
  warning: "text-status-warning",
  error: "text-status-error",
};

function Activity({ snapshot }: { snapshot: PipelineSnapshot }) {
  const { totals } = snapshot;
  return (
    <Card variant="surface" className="flex min-w-0 flex-col p-4 sm:p-5">
      <h2 className="type-h4">Activity</h2>
      {snapshot.activity.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Nothing has happened in the pipeline lately.</p>
      ) : (
        <ul className="mt-3 grid gap-2 text-sm">
          {snapshot.activity.map((a) => (
            <li key={a.id} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
              <time className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">{timeOfDay(a.at)}</time>
              <span className={TONE[a.tone]}>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-auto flex flex-wrap gap-x-4 gap-y-1 border-t pt-3 font-mono text-xs text-muted-foreground">
        <span>Last 24 hours</span>
        <span>
          Live <b className="font-semibold text-foreground">{totals.live}</b>
        </span>
        <span>
          Built elsewhere <b className="font-semibold text-foreground">{totals.elsewhere}</b>
        </span>
        <span>
          Fell back <b className="font-semibold text-foreground">{totals.fellBack}</b>
        </span>
        <span>
          Failed <b className="font-semibold text-foreground">{totals.failed}</b>
        </span>
      </div>
    </Card>
  );
}

export function PipelineView() {
  const { received, live } = usePipeline();
  const snapshot = received?.snapshot ?? null;
  const now = useNow(received?.offset ?? 0);
  const lanes = usePipelineLanes(snapshot);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="type-h2">Pipeline</h2>
          <p className="text-sm text-muted-foreground">
            Deploys move from the queue to live through this server&apos;s builder, or build on a linked builder and rejoin at Start.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
          <span aria-hidden className={cn("size-2 rounded-full", live ? "bg-status-success" : "bg-status-warning")} />
          {live ? "Live" : "Connecting"}
        </span>
      </div>

      {!snapshot ? (
        <Card variant="surface" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading the pipeline…
        </Card>
      ) : (
        <>
          <Card variant="surface" className="overflow-x-auto" aria-label="Pipeline map">
            <PipelineMap snapshot={snapshot} now={now} {...lanes} />
          </Card>

          <Card variant="surface" className="overflow-x-auto" aria-label="Jobs">
            <PipelineJobs jobs={snapshot.jobs} now={now} />
          </Card>

          <div className="grid gap-6 2xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <InFlight snapshot={snapshot} now={now} lanes={lanes.last} />
            <Activity snapshot={snapshot} />
          </div>

          <Card variant="surface" className="p-4 sm:p-5">
            <h2 className="type-h4 mb-3">Background loops</h2>
            <PipelineLoops groups={snapshot.loops} now={now} />
          </Card>
        </>
      )}
    </div>
  );
}

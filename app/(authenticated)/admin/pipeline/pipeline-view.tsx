"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { Input } from "@/components/ui/input";
import { StatusMark } from "@/components/ui/status-dot";
import { toast } from "@/lib/messenger";
import { deployHref } from "@/lib/ui/hrefs";
import type { PipelineMedians } from "@/lib/pipeline/medians";
import type { ActivityItem, PipelineDeploy, PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { PipelineBuilders } from "./pipeline-builders";
import { PipelineDeploys } from "./pipeline-deploys";
import { PipelineJobs } from "./pipeline-jobs";
import { PipelineStats } from "./pipeline-stats";
import { attentionRows, headChip, summarize, type AttentionRow } from "./summary";
import { DEFAULT_WINDOW, WINDOWS, type WindowKey } from "./timeline";

const SNAPSHOT_URL = "/api/v1/admin/pipeline";
const STREAM_URL = "/api/v1/admin/pipeline/stream";
const HISTORY_URL = "/api/v1/admin/pipeline/history";
/** Longer windows refetch their history this often, apart from the snapshot stream. */
const HISTORY_REFRESH_MS = 60_000;

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

/** Server time, ticking each second; holds still while paused. */
function useNow(offset: number, paused: boolean): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (paused) return;
    const id = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(id);
  }, [paused]);
  return clock + offset;
}

/** History for the 1h and 6h windows, fetched when chosen and then once a minute, never on the snapshot tick. */
function useHistory(window: WindowKey): { recent: PipelineDeploy[]; medians: PipelineMedians } | null {
  const [history, setHistory] = useState<{ window: WindowKey; recent: PipelineDeploy[]; medians: PipelineMedians } | null>(null);
  const wanted = window === "1h" || window === "6h";
  useEffect(() => {
    if (!wanted) return;
    let disposed = false;
    const load = () =>
      fetch(`${HISTORY_URL}?window=${window}`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { recent: PipelineDeploy[]; medians: PipelineMedians };
          if (!disposed) setHistory({ window, ...body });
        })
        .catch(() => {
          if (!disposed) toast.error(`Couldn't load the last ${window}`);
        });
    void load();
    const t = setInterval(load, HISTORY_REFRESH_MS);
    return () => {
      disposed = true;
      clearInterval(t);
    };
  }, [window, wanted]);
  return wanted && history?.window === window ? history : null;
}

function timeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).replace(/ [AP]M$/, "");
}

const TONE: Record<ActivityItem["tone"], string> = {
  default: "",
  success: "",
  warning: "text-status-warning",
  error: "text-status-error",
};

function Activity({ items }: { items: ActivityItem[] }) {
  return (
    <Card variant="surface" className="p-5">
      <h2 className="type-h4 mb-2.5">Activity</h2>
      {items.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing has happened in the pipeline lately.</p>
      ) : (
        <ul className="m-0 list-none p-0 text-[13px]">
          {items.map((a) => (
            <li key={a.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-2.5 py-1">
              <time className="font-mono text-[11.5px] leading-[1.9] tabular-nums text-muted-foreground">{timeOfDay(a.at)}</time>
              <span className={TONE[a.tone]}>{a.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Attention({ rows, onDetails }: { rows: AttentionRow[]; onDetails: (d: PipelineDeploy) => void }) {
  if (rows.length === 0) return null;
  const issue = rows.some((r) => r.tone === "issue");
  return (
    <Card variant={issue ? "error" : "warning"} className="px-5 py-1.5" aria-label="Needs attention">
      {rows.map((r) => (
        <div key={r.key} className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 border-t border-foreground/10 py-3 first:border-t-0">
          <span className="mt-1">
            <StatusMark tone={r.tone} />
          </span>
          <div className="min-w-0">
            <b className="font-semibold">{r.title}</b>
            {r.text ? <p className="mt-0.5 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{r.text}</p> : null}
          </div>
          <div className="flex flex-wrap justify-end gap-1.5">
            {r.deploy ? (
              <>
                <Button size="xs" onClick={() => onDetails(r.deploy!)}>
                  Details
                </Button>
                {r.deploy.appSlug ? (
                  <Button size="xs" variant="outline" asChild>
                    <Link href={deployHref(r.deploy.appSlug, r.deploy.id)}>Open deploy</Link>
                  </Button>
                ) : null}
              </>
            ) : null}
            {r.links?.map((l) => (
              <Button key={l.href} size="xs" variant="outline" asChild>
                <Link href={l.href}>{l.label}</Link>
              </Button>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

/** The newest activity item's id, to count what arrived while paused. */
const headId = (s: PipelineSnapshot | null) => s?.activity[0]?.id ?? null;

export function PipelineView() {
  const { received, live } = usePipeline();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const window = (params.get("window") as WindowKey | null) ?? DEFAULT_WINDOW;
  const windowKey: WindowKey = window in WINDOWS ? window : DEFAULT_WINDOW;
  const stages = params.get("rows") === "stages";

  const [paused, setPaused] = useState(false);
  const [held, setHeld] = useState<Received | null>(null);
  const [missed, setMissed] = useState(0);
  const lastHead = useRef<string | null>(null);
  const shown = paused ? held : received;
  const snapshot = shown?.snapshot ?? null;
  const now = useNow(shown?.offset ?? 0, paused);
  const history = useHistory(windowKey);

  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const filterRef = useRef<HTMLInputElement>(null);

  // Counts new activity that arrived while paused.
  useEffect(() => {
    const id = headId(received?.snapshot ?? null);
    if (paused && id !== null && id !== lastHead.current) setMissed((n) => n + 1);
    lastHead.current = id;
  }, [received, paused]);

  const togglePause = useCallback(() => {
    setPaused((p) => {
      if (!p) setHeld(received);
      else setMissed(0);
      return !p;
    });
  }, [received]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null) next.delete(key);
      else next.set(key, value);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") {
        e.preventDefault();
        filterRef.current?.focus();
      } else if (e.key === "p") togglePause();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [togglePause]);

  const attention = useMemo(() => (snapshot ? attentionRows(snapshot) : []), [snapshot]);
  const toggle = useCallback((id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <h2 className="type-h2">Pipeline</h2>
        <Card variant="surface" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading the pipeline…
        </Card>
      </div>
    );
  }

  const sum = summarize({ ...snapshot, at: now }, attention);
  const chip = headChip(snapshot, attention);

  return (
    <div className="min-w-0">
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <h2 className="type-h2">Pipeline</h2>
        <Chip tone={chip.tone}>{chip.label}</Chip>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Input
            ref={filterRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && (setFilter(""), e.currentTarget.blur())}
            placeholder="Filter by app, org or builder"
            aria-label="Filter deploys"
            className="h-9 w-60"
          />
          <Button variant="outline" size="sm" aria-pressed={paused} onClick={togglePause}>
            {paused ? `Resume${missed ? ` · ${missed} new` : ""}` : "Pause"}
          </Button>
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
            <span aria-hidden className={cn("size-[7px] rounded-full", paused || !live ? "bg-status-warning" : "bg-status-success")} />
            {paused ? "Paused" : live ? "Live" : "Connecting"}
          </span>
        </div>
      </div>

      <div className="mb-5 min-h-[58px]" aria-live="polite">
        <h3 className="type-h3 flex items-baseline gap-2">
          {sum.tone ? (
            <span className="self-center">
              <StatusMark tone={sum.tone} />
            </span>
          ) : null}
          {sum.title}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{sum.text}</p>
      </div>

      <div className="space-y-5">
        <Attention rows={attention} onDetails={(d) => setOpen((s) => new Set(s).add(d.id))} />
        <PipelineDeploys
          snapshot={snapshot}
          now={now}
          window={windowKey}
          onWindow={(w) => setParam("window", w === DEFAULT_WINDOW ? null : w)}
          stages={stages}
          onStages={(on) => setParam("rows", on ? "stages" : null)}
          history={history}
          filter={filter}
          onClearFilter={() => setFilter("")}
          open={open}
          onToggle={toggle}
        />
        <div className="grid items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
          <PipelineBuilders snapshot={snapshot} now={now} />
          <PipelineJobs snapshot={snapshot} now={now} />
          <PipelineStats snapshot={snapshot} />
        </div>
        <Activity items={snapshot.activity} />
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusMark } from "@/components/ui/status-dot";
import { toast } from "@/lib/messenger";
import { appHref, deployHref } from "@/lib/ui/hrefs";
import type { AppDrill, AppRow } from "@/lib/admin-apps/types";
import { formatBytes } from "@/lib/metrics/format";
import { cn } from "@/lib/utils";
import { barPieces } from "../pipeline/timeline";
import { PIECE_CLASS } from "../pipeline/track";
import { seriesPaths, yFor } from "./chart";
import { clockTime, headline } from "./drill";

const LIVE_REFRESH_MS = 15_000;

function useDrill(appId: string) {
  const [drill, setDrill] = useState<AppDrill | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const res = await fetch(`/api/v1/admin/apps/${appId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setDrill((await res.json()) as AppDrill);
  }, [appId]);
  useEffect(() => {
    let disposed = false;
    const run = () => load().catch(() => !disposed && setFailed(true));
    const first = setTimeout(run, 0);
    const t = setInterval(run, LIVE_REFRESH_MS);
    return () => {
      disposed = true;
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);
  return { drill, failed };
}

const LABEL_W = 96;

/** One labeled lane of the chart. */
function Lane({ label, note, swatch, height, children }: { label: string; note?: string; swatch?: string; height: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center" style={{ height }}>
      <span className="shrink-0 text-[11.5px] leading-tight text-muted-foreground" style={{ width: LABEL_W }}>
        <span className="flex items-center gap-1.5">
          {swatch ? <i aria-hidden className="inline-block h-[3px] w-2.5 rounded-sm" style={{ background: swatch }} /> : null}
          {label}
        </span>
        {note ? <span className="mt-0.5 block font-mono text-[10.5px]">{note}</span> : null}
      </span>
      <div className="relative h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** A metric strip: area and line, a dashed limit when given, dotted guides at each deploy's start. */
function Strip({ values, color, limit, limitLabel, guides }: { values: (number | null)[]; color: string; limit?: number | null; limitLabel?: string; guides: number[] }) {
  const W = 720;
  const H = 48;
  const peak = Math.max(0, ...values.filter((v): v is number => v !== null));
  const max = limit ? Math.max(limit * 1.05, peak * 1.05) : peak * 1.15 || 1;
  const { line, area } = seriesPaths(values, W, H, max);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
      {guides.map((g) => (
        <line key={g} x1={g * W} x2={g * W} y1={0} y2={H} stroke="var(--foreground)" strokeOpacity={0.25} strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
      ))}
      <path d={area} fill={color} opacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      {limit ? (
        <line x1={0} x2={W} y1={yFor(limit, H, max)} y2={yFor(limit, H, max)} stroke="var(--chart-reference)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke">
          <title>{limitLabel}</title>
        </line>
      ) : null}
    </svg>
  );
}

function Chart({ d, now }: { d: AppDrill; now: number }) {
  const span = d.to - d.from;
  const pct = (t: number) => ((t - d.from) / span) * 100;
  const place = (start: number, end: number) => {
    const l = Math.max(0, pct(start));
    const r = Math.min(100, pct(end));
    return r > l ? { left: `${l}%`, width: `max(2px, ${r - l}%)` } : null;
  };
  const guides = d.deploys.flatMap((x) => {
    const s = x.segments.find((seg) => seg.stage === "start");
    return s && s.start > d.from && s.start < d.to ? [(s.start - d.from) / span] : [];
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => d.from + f * span);
  return (
    <div className="min-w-0">
      <Lane label="Deploys" height={34}>
        {d.deploys.map((x) => {
          const first = place(x.queuedAt, x.queuedAt + 1);
          return (
            <div key={x.id}>
              {first ? (
                <span className="absolute top-0 truncate text-[10.5px] text-muted-foreground" style={{ left: first.left, maxWidth: "45%" }}>
                  {clockTime(x.queuedAt)}
                  {x.commit ? ` · ${x.commit}` : ""}
                </span>
              ) : null}
              {barPieces(x, now).map((p) => {
                const at = place(p.start, p.end);
                return at ? <span key={p.key} title={p.title} className={cn("absolute top-[22px] -translate-y-1/2 rounded-[2px] shadow-[1px_0_0_var(--row-hover)]", PIECE_CLASS[p.kind])} style={at} /> : null;
              })}
            </div>
          );
        })}
      </Lane>
      <Lane label="Backups, uptime" height={20}>
        {d.backups.map((b) => {
          const at = place(b.start, b.end ?? now);
          return at ? <span key={`b${b.start}`} title={b.failed ? "Backup failed" : "Backup"} className={cn("absolute top-1.5 h-2 rounded-[1px]", b.failed ? "bg-status-error" : "bg-st-prep")} style={at} /> : null;
        })}
        {d.outages.map((o) => {
          const at = place(o.start, o.end ?? now);
          return at ? <span key={`o${o.start}`} title="Down" className="absolute top-1.5 h-2 rounded-[1px] bg-status-error" style={at} /> : null;
        })}
      </Lane>
      <Lane label="Memory" note={d.memoryLimit ? `${formatBytes(d.memoryLimit)} limit` : undefined} swatch="var(--chart-memory)" height={52}>
        <Strip values={d.memory} color="var(--chart-memory)" limit={d.memoryLimit} limitLabel={d.memoryLimit ? `${formatBytes(d.memoryLimit)} limit` : undefined} guides={guides} />
      </Lane>
      <Lane label="CPU" swatch="var(--chart-cpu)" height={52}>
        <Strip values={d.cpu} color="var(--chart-cpu)" guides={guides} />
      </Lane>
      <div className="flex justify-between pt-1 font-mono text-[10.5px] text-muted-foreground" style={{ marginLeft: LABEL_W }}>
        {ticks.map((t) => (
          <span key={t}>{clockTime(t)}</span>
        ))}
      </div>
    </div>
  );
}

export function AppDrillIn({ app, now }: { app: AppRow; now: number }) {
  const { drill, failed } = useDrill(app.id);
  const [busy, setBusy] = useState(false);

  const redeploy = async () => {
    if (!drill?.latestDeployId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/v1/admin/pipeline/deploys/${drill.latestDeployId}/redeploy`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
      toast.success(`Queued a deploy of ${app.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  if (!drill) {
    return (
      <div className="flex items-center gap-2 px-5 py-4 pl-12 text-[13px] text-muted-foreground">
        {failed ? (
          "Couldn't load this app's last day."
        ) : (
          <>
            <Loader2 className="size-4 animate-spin" />
            Loading…
          </>
        )}
      </div>
    );
  }

  const head = headline(drill, now);
  return (
    <div className="grid gap-7 px-5 pt-1.5 pb-5 pl-12 whitespace-normal lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0">
        <h4 className="type-h4 mt-1 text-sm">{head.title}</h4>
        <p className="mt-0.5 mb-3 text-[13px] text-muted-foreground">{head.lead}</p>
        <Chart d={drill} now={now} />
      </div>
      <div className="min-w-0">
        <div className="mt-1 mb-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">Recent</div>
        {drill.events.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">Nothing in the last 12 hours.</p>
        ) : (
          <ul className="m-0 list-none p-0 text-[12.5px]">
            {drill.events.map((e, i) => (
              <li key={`${e.at}-${i}`} className="grid grid-cols-[46px_12px_minmax(0,1fr)] items-baseline gap-2 py-1.5 shadow-[0_1px_0_color-mix(in_oklch,var(--foreground)_8%,transparent)]">
                <time className="font-mono text-[11.5px] tabular-nums text-muted-foreground">{clockTime(e.at)}</time>
                <span className="translate-y-0.5">
                  <StatusMark tone={e.tone === "issue" ? "issue" : e.tone === "warn" ? "warn" : "neutral"} />
                </span>
                <span className={cn("min-w-0 truncate", e.tone === "issue" && "text-status-error")} title={e.text}>
                  {e.text}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="px-2.5" asChild>
            <Link href={appHref(app.slug)}>Open app</Link>
          </Button>
          {drill.latestDeployId ? (
            <Button size="sm" variant="outline" className="px-2.5" asChild>
              <Link href={deployHref(app.slug, drill.latestDeployId)}>Deploy log</Link>
            </Button>
          ) : null}
          {drill.latestDeployId ? (
            <Button size="sm" variant="outline" className="px-2.5" disabled={busy} onClick={() => void redeploy()}>
              Redeploy
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

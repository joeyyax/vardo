"use client";

import { Fragment } from "react";
import { StatusMark } from "@/components/ui/status-dot";
import type { AppRow, Ribbon as RibbonData } from "@/lib/admin-apps/types";
import { duration } from "@/lib/admin-apps/shape";
import { cpuDisplay, formatBytes, formatBytesRateShort } from "@/lib/metrics/format";
import { cn } from "@/lib/utils";
import { span } from "../pipeline/timeline";
import { seriesPaths } from "./chart";
import { AppDrillIn } from "./app-drill-in";
import { firstDir, nearLimit, rowTone, subLine, type Group, type GroupBy, type RowTone, type Sort, type SortKey } from "./table";

const DAY = 24 * 60 * 60_000;
/** The ribbon runs a little past now. */
const AHEAD = 40 * 60_000;

function Mark({ tone }: { tone: RowTone }) {
  return tone === "active" ? <StatusMark tone="signal" pending /> : <StatusMark tone={tone} />;
}

export function Spark({ values, max, tone, w = 64, h = 22 }: { values: (number | null)[]; max?: number | null; tone?: "warn" | null; w?: number; h?: number }) {
  const { line, area } = seriesPaths(values, w, h, max);
  const color = tone === "warn" ? "var(--status-warning)" : "var(--muted-foreground)";
  return (
    <svg aria-hidden width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0">
      <path d={area} fill={color} opacity={tone === "warn" ? 0.16 : 0.1} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

/** The last 24 hours: deploys on top, backups and cron runs below, outages on the line. */
function Ribbon({ r, now }: { r: RibbonData; now: number }) {
  const t0 = now - DAY;
  const x = (t: number) => Math.max(0, Math.min(100, ((t - t0) / (DAY + AHEAD)) * 100));
  const at = (start: number, end: number | null, min = 0.5) => {
    const l = x(start);
    return { left: `${l}%`, width: `max(${min}%, ${Math.max(0, x(end ?? now) - l)}%)` };
  };
  const nowX = x(now);
  const time = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (
    <div className="relative h-7 min-w-[180px]">
      <span aria-hidden className="absolute inset-x-0 top-[13px] h-0.5 rounded-full bg-muted dark:bg-secondary" />
      <span aria-hidden className="track-future absolute inset-y-0 right-0 rounded-[3px]" style={{ left: `${nowX}%` }} />
      {r.crons.map((c) => (
        <span
          key={`c${c.at}`}
          title={`${c.runs} cron ${c.runs === 1 ? "run" : "runs"} at ${time(c.at)}${c.failed ? `, ${c.failed} failed` : ""}`}
          className={cn("absolute top-[21px] h-[3px] w-px", c.failed ? "bg-status-error" : "bg-muted-foreground/55")}
          style={{ left: `${x(c.at)}%` }}
        />
      ))}
      {r.backups.map((b) => (
        <span
          key={`b${b.start}`}
          title={`Backup at ${time(b.start)}${b.failed ? " failed" : b.end === null ? ", running" : ""}`}
          className={cn("absolute top-[18px] h-1.5 rounded-[1px]", b.failed ? "bg-status-error" : "bg-st-prep")}
          style={at(b.start, b.end, 0.6)}
        />
      ))}
      {r.outages.map((o) => (
        <span
          key={`o${o.start}`}
          title={o.end === null ? `Down since ${time(o.start)}` : `Down ${duration(o.end - o.start)} at ${time(o.start)}`}
          className="absolute top-3 h-1 rounded-[1px] bg-status-error"
          style={at(o.start, o.end, 1)}
        />
      ))}
      {r.deploys.map((d) => (
        <Fragment key={`d${d.start}`}>
          {d.waits.map((w) => (
            <span key={`w${w.start}`} title="Waiting for a builder" className="absolute top-[3px] h-[9px] rounded-[1px] bg-status-warning" style={at(w.start, w.end, 0.3)} />
          ))}
          <span
            title={`Deploy at ${time(d.start)}${d.failed ? ", failed" : d.end === null ? ", running" : ""}`}
            className={cn("absolute top-[3px] h-[9px] rounded-[1px] shadow-[1px_0_0_var(--card)]", d.failed ? "bg-status-error" : d.end === null ? "bg-foreground" : "bg-st-start")}
            style={at(d.waits.reduce((s, w) => Math.max(s, w.end ?? now), d.start), d.end, 0.8)}
          />
        </Fragment>
      ))}
      <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${nowX}%` }} />
    </div>
  );
}

/** Percent of one core, as the collector reports it. */
function corePercent(p: number): string {
  if (p > 0 && p < 1) return "<1%";
  return `${Math.round(p)}%`;
}

function uptimeText(u: number): string {
  const pct = u * 100;
  if (pct >= 99.995) return "100%";
  return `${pct.toFixed(2)}%`;
}

const LAST: Record<string, string> = { failed: "Failed", rolled_back: "Rolled back" };

function Row({ a, group, now, open, onToggle }: { a: AppRow; group: GroupBy; now: number; open: boolean; onToggle: () => void }) {
  const sub = subLine(a, group);
  const near = nearLimit(a);
  const cpu = cpuDisplay(a.cpu, a.cpuLimit ? { kind: "enforced", cores: a.cpuLimit } : { kind: "none" });
  const last = a.lastDeploy;
  return (
    <>
      <tr
        className={cn("cursor-pointer outline-none hover:bg-row-hover focus-visible:bg-row-hover focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset", open && "bg-row-hover")}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={0}
        aria-expanded={open}
      >
        <td className="w-7 pr-0!">
          <Mark tone={rowTone(a)} />
        </td>
        <td className="max-w-[160px]">
          <span className="block truncate font-semibold">{a.name}</span>
          <span className={cn("block truncate text-xs leading-tight text-muted-foreground", sub.tone === "warn" && "text-status-warning", sub.tone === "issue" && "text-status-error")}>
            {sub.text || " "}
          </span>
        </td>
        <td className="w-full min-w-[150px]">
          <Ribbon r={a.ribbon} now={now} />
        </td>
        <td>
          <div className="flex items-center justify-end gap-2">
            <Spark values={a.spark.cpu} w={48} />
            <span className="min-w-[38px] text-right font-mono text-[12.5px] tabular-nums" title={cpu.compact}>
              {a.cpu === null ? "–" : corePercent(a.cpu)}
            </span>
          </div>
        </td>
        <td>
          <div className="flex items-center justify-end gap-2">
            <Spark values={a.spark.memory} max={a.memoryLimit} tone={near ? "warn" : null} w={48} />
            <span className="min-w-[74px] text-right font-mono text-[12.5px] leading-tight tabular-nums">
              <span className={cn(near && "text-status-warning")}>{a.memory === null ? "–" : formatBytes(a.memory)}</span>
              <small className="block text-[11px] text-muted-foreground">
                {a.memory !== null && a.memoryLimit ? `${Math.round((a.memory / a.memoryLimit) * 100)}% of ${formatBytes(a.memoryLimit)}` : a.memory !== null ? "No limit" : " "}
              </small>
            </span>
          </div>
        </td>
        <td>
          <div className="flex items-center justify-end gap-2">
            <Spark values={a.spark.net} w={48} />
            <span className="min-w-[76px] text-right font-mono text-xs leading-tight tabular-nums text-muted-foreground">
              in <span className="text-foreground">{a.rx === null ? "–" : formatBytesRateShort(a.rx)}</span>
              <span className="block">
                out <span className="text-foreground">{a.tx === null ? "–" : formatBytesRateShort(a.tx)}</span>
              </span>
            </span>
          </div>
        </td>
        <td className={cn("text-right font-mono text-[12.5px] tabular-nums", a.uptime !== null && a.uptime < 0.999 && "text-status-error", a.uptime === null && "text-muted-foreground")}>
          {a.uptime === null ? "–" : uptimeText(a.uptime)}
        </td>
        <td className="text-right">
          {last ? (
            <>
              <span className="block font-mono text-[12.5px] tabular-nums">{span(now - last.at)} ago</span>
              <span className={cn("block text-xs leading-tight text-muted-foreground", LAST[last.status] && "text-status-error")}>{LAST[last.status] ?? duration(last.ms)}</span>
            </>
          ) : (
            <span className="text-muted-foreground">–</span>
          )}
        </td>
      </tr>
      {open ? (
        <tr className="bg-row-hover">
          <td colSpan={8} className="p-0!">
            <AppDrillIn app={a} now={now} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

const COLUMNS: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "name", label: "App" },
  { key: null, label: "Last 24 hours" },
  { key: "cpu", label: "CPU", align: "right" },
  { key: "memory", label: "Memory", align: "right" },
  { key: "network", label: "Network", align: "right" },
  { key: "uptime", label: "Uptime", align: "right" },
  { key: "deploy", label: "Last deploy", align: "right" },
];

export function AppsTable({
  groups,
  group,
  now,
  sort,
  onSort,
  open,
  onToggle,
}: {
  groups: Group[];
  group: GroupBy;
  now: number;
  sort: Sort;
  onSort: (s: Sort) => void;
  open: string | null;
  onToggle: (id: string) => void;
}) {
  return (
    <table className="w-full border-collapse text-[13px] whitespace-nowrap [&_td]:h-[46px] [&_td]:px-2 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5 [&_td]:align-middle [&_tbody_tr]:shadow-[0_-1px_0_color-mix(in_oklch,var(--foreground)_8%,transparent)]">
      <thead>
        <tr>
          <th className="w-7 pl-5" />
          {COLUMNS.map((c, i) => {
            const active = c.key !== null && sort.key === c.key;
            const label =
              c.key === null ? (
                <span className="flex justify-between">
                  <span>{c.label}</span>
                  <span>now</span>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => onSort(active ? { key: c.key!, dir: sort.dir === "asc" ? "desc" : "asc" } : { key: c.key!, dir: firstDir(c.key!) })}
                  className={cn("inline-flex cursor-pointer items-center gap-1 uppercase hover:text-foreground", active && "text-foreground")}
                >
                  {c.label}
                  {active ? <span aria-hidden>{sort.dir === "asc" ? "↑" : "↓"}</span> : null}
                </button>
              );
            return (
              <th
                key={c.label}
                aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                className={cn(
                  "px-2 pt-3.5 pb-2 text-left text-[10.5px] font-semibold tracking-[0.08em] text-muted-foreground uppercase",
                  c.align === "right" && "text-right",
                  i === COLUMNS.length - 1 && "pr-5",
                )}
              >
                {label}
              </th>
            );
          })}
        </tr>
      </thead>
      {groups.map((g) => (
        <tbody key={g.key}>
          {g.name !== null ? (
            <tr className="bg-background-deep shadow-none!">
              <td colSpan={4} className="h-10!">
                <span className="type-h4 text-[13.5px]">{g.name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {g.apps.length} {g.apps.length === 1 ? "app" : "apps"}
                </span>
              </td>
              <td className="h-10! text-right font-mono text-xs tabular-nums text-muted-foreground">{g.memory === null ? "" : formatBytes(g.memory)}</td>
              <td colSpan={3} className="h-10!" />
            </tr>
          ) : null}
          {g.apps.map((a) => (
            <Row key={a.id} a={a} group={group} now={now} open={open === a.id} onToggle={() => onToggle(a.id)} />
          ))}
        </tbody>
      ))}
    </table>
  );
}

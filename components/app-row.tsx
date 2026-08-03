"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Cpu, Package, ShieldCheck, Trash2 } from "lucide-react";

import { worstCondition, type AppCondition } from "@/lib/docker/conditions";
import { conditionLabel, conditionTone } from "@/lib/ui/conditions";
import { statusDotColor } from "@/lib/ui/status-colors";
import {
  compactUptime,
  railClass,
  rowSeverity,
  sparkPath,
  sparklineTone,
  statusWord,
  statusWordTone,
  tagLabels,
} from "@/lib/ui/app-row";

export type AppRowApp = {
  displayName: string;
  status: string;
  conditions?: AppCondition[] | null;
  containerStartedAt?: Date | string | null;
  needsRedeploy?: boolean | null;
  priority?: "critical" | "standard" | "disposable" | null;
  gpuEnabled?: boolean | null;
  tags?: string[];
};

/** Fills the condition column when nothing worse is true. */
export type RowNote = { label: string; tone: string; title?: string };

// Ticks slowly: the column reads in minutes and above, and a ledger renders a
// hundred of these. Client-only so server and client never disagree.
function RowUptime({ since }: { since: Date | string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => setText(compactUptime(since));
    tick();
    const id = setInterval(tick, 30000);
    return () => clearInterval(id);
  }, [since]);
  return <>{text ?? ""}</>;
}

/** 64x18, single stroke, endpoint dot. Colour comes from the row's state. */
function RowSparkline({ data }: { data: number[] }) {
  const path = sparkPath(data);
  if (!path) return null;
  return (
    <svg viewBox="0 0 64 18" width="64" height="18" aria-hidden="true">
      <path
        d={path.d}
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={path.end[0]} cy={path.end[1]} r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * One app or service on one ~30px line. Columns are fixed from the uptime
 * figure rightwards so a stack of rows aligns; the tag column drops out on
 * narrow containers and the hover card carries it instead.
 */
export function AppRow({
  app,
  href,
  series,
  updateCount = 0,
  sharedStatus,
  note,
  indented = false,
  related = false,
  trailing,
  ref,
  ...rest
}: {
  app: AppRowApp;
  href: string;
  /** CPU history for the trailing sparkline. */
  series?: number[];
  updateCount?: number;
  /** Status the container already states for every row; matching rows stay quiet. */
  sharedStatus?: string | null;
  note?: RowNote;
  indented?: boolean;
  related?: boolean;
  /** Controls that must stay clickable, stacked above the row link. */
  trailing?: React.ReactNode;
  ref?: React.Ref<HTMLAnchorElement>;
} & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const severity = rowSeverity(app.status, app.conditions, !!app.needsRedeploy);
  const rail = railClass(severity);
  const word = statusWord(app.status, sharedStatus);
  const worst = worstCondition(app.conditions ?? []);
  const running = app.status === "active";

  const shownNote: RowNote | null = worst
    ? { label: conditionLabel(worst), tone: conditionTone(worst.severity), title: worst.detail }
    : app.needsRedeploy
      ? {
          label: "restart needed",
          tone: "text-status-warning",
          title: "Config changed since the last deploy",
        }
      : (note ?? null);

  const tags = tagLabels(app.tags ?? []);

  return (
    <div className={`relative flex items-center ${related ? "bg-accent/40" : ""}`}>
      {/* The link is the row: hover and focus both land on it, so a tooltip
          anchored here opens for the keyboard too. */}
      <Link
        ref={ref}
        href={href}
        className={`relative z-10 flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-md pr-2 text-xs font-medium transition-colors hover:bg-accent/60 ${indented ? "pl-7" : "pl-2.5"}`}
        {...rest}
      >
        {rail && (
          <span
            aria-hidden="true"
            className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full ${rail}`}
          />
        )}

        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDotColor(app.status)}`} />
        <span className="truncate">{app.displayName}</span>
        {running && <span className="sr-only">, Running</span>}

        {word && <span className={`shrink-0 font-normal ${statusWordTone(app.status)}`}>{word}</span>}
        {/* Takes only the space the name and the fixed columns leave, so a long
            condition truncates and the name never does. */}
        {shownNote && (
          <span
            className={`min-w-0 flex-1 truncate font-normal ${shownNote.tone}`}
            title={shownNote.title}
          >
            {shownNote.label}
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-2.5 font-normal">
          {tags.shown.length > 0 && (
            <span className="hidden max-w-32 truncate text-muted-foreground/60 @[34rem]:inline">
              {tags.shown.join(" ")}
              {tags.overflow > 0 && ` +${tags.overflow}`}
            </span>
          )}
          <span className="hidden w-9 text-right tabular-nums text-muted-foreground/70 @[20rem]:inline">
            {running && app.containerStartedAt ? <RowUptime since={app.containerStartedAt} /> : ""}
          </span>
          <span
            className={`flex h-[18px] w-16 items-center justify-end ${sparklineTone(severity)}`}
            aria-hidden="true"
          >
            {series && <RowSparkline data={series} />}
          </span>
          <span className="flex w-14 items-center justify-end gap-1.5">
            {updateCount > 0 && (
              <Package className="size-3 text-status-update" aria-label="Update available" />
            )}
            {app.priority === "critical" && (
              <ShieldCheck className="size-3 text-status-critical" aria-label="Critical priority" />
            )}
            {app.priority === "disposable" && (
              <Trash2 className="size-3 text-status-disposable" aria-label="Disposable priority" />
            )}
            {/* Achromatic until the GPU sweep tokens land. */}
            {app.gpuEnabled && (
              <Cpu className="size-3 text-muted-foreground" aria-label="GPU passthrough enabled" />
            )}
          </span>
        </span>
      </Link>
      {trailing && <div className="relative z-20 shrink-0 pr-1">{trailing}</div>}
    </div>
  );
}

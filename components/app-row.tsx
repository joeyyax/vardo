"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CircleDashed, Cpu, Package, ShieldCheck } from "lucide-react";

import { type AppCondition } from "@/lib/docker/conditions";
import { statusDotColor } from "@/lib/ui/status-colors";
import {
  compactUptime,
  primaryDomain,
  railClass,
  rowNote,
  rowSeverity,
  sourceRef,
  sparkPath,
  sparklineTone,
  statusWord,
  statusWordTone,
  tagLabels,
  ROW_DOMAIN_CELL,
  ROW_NAME_CELL,
  ROW_NOTE_CELL,
  ROW_SOURCE_CELL,
  ROW_TRAILING_CELL,
  type RowNote,
} from "@/lib/ui/app-row";

export type AppRowApp = {
  displayName: string;
  status: string;
  conditions?: AppCondition[] | null;
  containerStartedAt?: Date | string | null;
  needsRedeploy?: boolean | null;
  priority?: "critical" | "standard" | "disposable" | null;
  gpuEnabled?: boolean | null;
  imageName?: string | null;
  gitUrl?: string | null;
  domains?: { domain: string; isPrimary?: boolean | null }[] | null;
  tags?: string[];
};

export type { RowNote };

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
 * One app or service on one ~30px line. Columns are fixed from the source
 * reference rightwards so a stack of rows aligns, and each column drops out at
 * the width where the columns left of it stop fitting — decoration first, the
 * name last.
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
  const running = app.status === "active";

  const shownNote = rowNote(app.conditions, app.needsRedeploy, note);
  const source = sourceRef(app);
  const domain = primaryDomain(app.domains);
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
        {/* Compose children share their parent's name; the elbow says whose. */}
        {indented && (
          <span
            aria-hidden="true"
            className="absolute left-3.5 top-0 h-1/2 w-2 rounded-bl-[3px] border-b border-l border-border"
          />
        )}

        <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${statusDotColor(app.status)}`} />
        <span className={ROW_NAME_CELL}>{app.displayName}</span>
        {indented && <span className="sr-only">, compose service</span>}
        {running && <span className="sr-only">, Running</span>}

        {word && <span className={`shrink-0 font-normal ${statusWordTone(app.status)}`}>{word}</span>}
        {/* Weighed to give up width long before the name does. */}
        {shownNote && (
          <span className={`${ROW_NOTE_CELL} font-normal ${shownNote.tone}`} title={shownNote.detail}>
            {shownNote.label}
          </span>
        )}

        <span className={`${ROW_TRAILING_CELL} font-normal text-muted-foreground/70`}>
          {/* The two facts that used to leave the middle of a wide row empty. */}
          <span className={`${ROW_SOURCE_CELL} hidden @[52rem]:block`}>{source ?? ""}</span>
          <span className={`${ROW_DOMAIN_CELL} hidden @[68rem]:block`}>{domain ?? ""}</span>
          {tags.shown.length > 0 && (
            <span className="hidden max-w-32 truncate text-muted-foreground/60 @[34rem]:inline">
              {tags.shown.join(" ")}
              {tags.overflow > 0 && ` +${tags.overflow}`}
            </span>
          )}
          {/* The figure outranks the squiggle: uptime holds at every width. */}
          <span className="w-9 shrink-0 text-right tabular-nums">
            {running && app.containerStartedAt ? <RowUptime since={app.containerStartedAt} /> : ""}
          </span>
          <span
            className={`hidden h-[18px] w-16 shrink-0 items-center justify-end @[26rem]:flex ${sparklineTone(severity)}`}
            aria-hidden="true"
          >
            {series && <RowSparkline data={series} />}
          </span>
          {/* Attributes stay achromatic; only the actionable update takes a hue. */}
          <span className="flex shrink-0 items-center justify-end gap-1.5 @[26rem]:w-14">
            {updateCount > 0 && (
              <Package className="size-3 text-status-update" aria-label="Update available" />
            )}
            {app.priority === "critical" && (
              <ShieldCheck className="size-3" aria-label="Critical priority" />
            )}
            {app.priority === "disposable" && (
              <CircleDashed className="size-3" aria-label="Disposable priority" />
            )}
            {app.gpuEnabled && <Cpu className="size-3" aria-label="GPU passthrough enabled" />}
          </span>
        </span>
      </Link>
      {trailing && <div className="relative z-20 shrink-0 pr-1">{trailing}</div>}
    </div>
  );
}

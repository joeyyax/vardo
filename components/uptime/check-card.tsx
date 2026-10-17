"use client";

import { useState } from "react";
import { Chip } from "@/components/ui/chip";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import {
  checkLabel,
  expectation,
  figureWithSince,
  formatMs,
  intervalLabel,
  reportNote,
  readingLabel,
  stateLabel,
} from "@/lib/uptime/format";
import type { MonitorDetail, MonitorSummary, VantageView } from "@/lib/uptime/types";
import { CheckNote, ReviewCard } from "./health-parts";
import { MonitorActions } from "./monitor-actions";
import { MonitorHistory } from "./monitor-history";
import { DayTicks, StateMark, TargetLink } from "./parts";
import { useUptimeTimeZone } from "./time-zone";

/**
 * One check, with everything needed to manage it in place: state, range figures, path and expected response, the review question,
 * the actions, and its response chart and outages in an expandable section.
 */
export function CheckCard({
  monitor: m,
  apiBase,
  canManage,
  vantages,
  checkedFrom,
  now,
  onChanged,
}: {
  monitor: MonitorSummary;
  apiBase: string;
  canManage: boolean;
  vantages: VantageView[];
  checkedFrom?: string;
  now: number;
  onChanged: () => void;
}) {
  const timeZone = useUptimeTimeZone();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<MonitorDetail | null>(null);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) await loadDetail();
  }

  async function loadDetail() {
    try {
      const res = await fetch(`${apiBase}/${m.id}?range=${m.range}`);
      if (!res.ok) throw new Error();
      setDetail((await res.json()).monitor);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  const changed = () => {
    onChanged();
    if (open) void loadDetail();
  };

  return (
    <li className="grid gap-3 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <StateMark state={m.enabled ? m.state : "unknown"} />
            <span className="truncate text-sm font-medium">{m.name}</span>
            <span className="text-xs text-muted-foreground">{m.enabled ? stateLabel(m.state, m.downSince, now) : "Off"}</span>
            {m.preview && <Chip tone="info" caps={false}>Preview</Chip>}
            {m.muted && <Chip tone="neutral" caps={false}>Muted</Chip>}
            {m.source === "manual" && <Chip tone="neutral" caps={false}>Added by hand</Chip>}
            {m.overrides && <Chip tone="info" caps={false}>Edited</Chip>}
            {m.domainRemoved && <Chip tone="warn" caps={false}>Domain removed from app</Chip>}
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1 break-all font-mono text-xs text-muted-foreground">
            <TargetLink monitor={m} />
            <span>
              · {checkLabel(m.check)} · {intervalLabel(m.intervalSec)} · {expectation(m.check)}
            </span>
          </p>
          <CheckNote monitor={m} />
          {(m.reading || m.report) && (
            <p className="text-xs text-muted-foreground">{[m.reading && readingLabel(m.reading), reportNote(m.report)].filter(Boolean).join(" · ")}</p>
          )}
        </div>
        <div className="text-right text-sm tabular-nums">
          <p className="font-medium">{figureWithSince(m.rangeUptime, m.since, now, timeZone)}</p>
          <p className="text-xs text-muted-foreground">{formatMs(m.latencyMs)}</p>
        </div>
      </div>

      <DayTicks days={m.bars} barMs={m.barMs} range={m.range} />

      <ReviewCard monitor={m} apiBase={apiBase} canManage={canManage} onAnswered={changed} />

      {canManage && <MonitorActions compact monitor={m} apiBase={apiBase} vantages={vantages} checkedFrom={checkedFrom} now={now} onChanged={changed} onDeleted={changed} />}

      <div>
        <button type="button" aria-expanded={open} onClick={toggle} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          <DisclosureChevron open={open} />
          Response time and outages
        </button>
        {open && (
          <div className="mt-3">
            {detail ? <MonitorHistory detail={detail} /> : failed ? <p className="text-sm text-muted-foreground">Couldn&apos;t load the history.</p> : <p className="text-sm text-muted-foreground">Loading…</p>}
          </div>
        )}
      </div>
    </li>
  );
}

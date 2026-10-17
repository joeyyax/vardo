"use client";

import { RangePicker } from "@/components/range-picker";
import { RANGE_LABELS, UPTIME_RANGES, rangeSlots, sinceLabel, type UptimeRange } from "@/lib/uptime/core/range";

const OPTIONS = UPTIME_RANGES.map((value) => ({ value, label: value }));

/** 1h, 24h, 7d, 30d and 90d, as segmented buttons. */
export function UptimeRangePicker({ value, onChange }: { value: UptimeRange; onChange: (range: UptimeRange) => void }) {
  return <RangePicker options={OPTIONS} value={value} onChange={onChange} label="Uptime range" />;
}

/** Under the bars: where they start, and "Now" at the end. A young monitor's bars start at its history. */
export function BarsCaption({ range, since, now, bars }: { range: UptimeRange; since: number | null; now: number; bars?: number }) {
  // The "Since" label sits at the left end of the drawn bars.
  const indent = since !== null && bars ? `${(1 - bars / rangeSlots(range)) * 100}%` : undefined;
  return (
    <div className="flex justify-between text-xs text-muted-foreground" style={{ marginLeft: indent }}>
      <span>{since !== null ? `Since ${sinceLabel(since, now)}` : `${RANGE_LABELS[range]} ago`}</span>
      <span>Now</span>
    </div>
  );
}

"use client";

import { Card } from "@/components/ui/card";
import type { PipelineSnapshot } from "@/lib/pipeline/types";
import { cn } from "@/lib/utils";
import { clock } from "./timeline";

/** Hourly live deploys as a quiet line, oldest left. */
function Spark({ values, w = 96, h = 22 }: { values: number[]; w?: number; h?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Live deploys per hour, last 24 hours: ${values.join(", ")}`} className="mt-1">
      <polyline points={points} fill="none" stroke="var(--muted-foreground)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Stat({ value, label, warn }: { value: string | number; label: string; warn?: boolean }) {
  const zero = value === 0;
  return (
    <div>
      <b className={cn("block text-[22px] leading-[1.1] font-semibold tracking-[-0.01em] tabular-nums", zero && "text-muted-foreground/60", warn && !zero && "text-status-warning")}>{value}</b>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export function PipelineStats({ snapshot }: { snapshot: PipelineSnapshot }) {
  const t = snapshot.totals;
  const targets = snapshot.builders.filter((b) => b.id !== "local");
  return (
    <Card variant="surface" className="p-5">
      <h2 className="type-h4 mb-2.5">Last 24 hours</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3.5">
        <div>
          <Stat value={t.live} label="Live" />
          {t.hourly ? <Spark values={t.hourly} /> : null}
        </div>
        <Stat value={t.medianToLiveMs ? clock(t.medianToLiveMs) : "–"} label="Median to live" />
        <Stat value={t.elsewhere} label={targets.length === 1 ? `Built on ${targets[0].name}` : "Built elsewhere"} />
        <Stat value={t.fellBack} label="Fell back" warn />
        <Stat value={t.failed} label="Failed or rolled back" />
      </div>
    </Card>
  );
}

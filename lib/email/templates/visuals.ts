// Chart builders shared by the templates.

import { formatBytesIec } from "@/lib/metrics/format";
import type { ChartTone, MailFact, MailVisual } from "./components";

/** The last 24 hours as columns; `over` marks values above it. */
export function hourlyColumns(
  title: string,
  values: number[] | undefined,
  opts: { over?: number; caption?: string } = {},
): MailVisual | undefined {
  if (!values || values.length < 2 || values.every((v) => v === 0)) return undefined;
  return {
    kind: "columns",
    title,
    columns: values.map((value) => ({ parts: [{ value, tone: (opts.over !== undefined && value > opts.over ? "warn" : 2) as ChartTone }] })),
    axis: ["24 h ago", "now"],
    caption: opts.caption,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** A drop this far below the median of earlier runs looks like lost data. */
export const BACKUP_DROP_RATIO = 0.3;

/** How far `current` sits below the median of `history`, when it's a worrying drop. Needs 3 earlier runs. */
export function backupDrop(history: number[], current: number): { median: number; drop: number } | null {
  if (history.length < 3) return null;
  const m = median(history);
  if (m <= 0) return null;
  const drop = (m - current) / m;
  return drop > BACKUP_DROP_RATIO ? { median: m, drop } : null;
}

/** A short sparkline of recent readings. */
export function sparkColumns(
  title: string,
  values: number[] | undefined,
  opts: { axis?: [string, string]; caption?: string; over?: number } = {},
): MailVisual | undefined {
  if (!values || values.length < 2 || values.every((v) => v === 0)) return undefined;
  return {
    kind: "columns",
    title,
    compact: true,
    columns: values.map((value) => ({ parts: [{ value, tone: (opts.over !== undefined && value >= opts.over ? "warn" : 2) as ChartTone }] })),
    axis: opts.axis,
    caption: opts.caption,
  };
}

/** Sizes of earlier runs plus this one, with this one marked. A failed run is a short red stub. */
export function backupColumns(
  volume: string,
  history: number[] | undefined,
  current: number | null,
): { visual: MailVisual; warning?: MailFact } | undefined {
  if (!history?.length) return undefined;
  const drop = current !== null ? backupDrop(history, current) : null;
  const max = Math.max(...history, current ?? 0);
  const now = current === null ? { value: max * 0.06, tone: "fail" as ChartTone } : { value: current, tone: (drop ? "warn" : 0) as ChartTone };
  const visual: MailVisual = {
    kind: "columns",
    title: `${volume}, last ${history.length + 1} runs`,
    columns: [...history.map((value) => ({ parts: [{ value, tone: 2 as ChartTone }] })), { parts: [now] }],
    axis: ["older", current === null ? "this run failed" : `this run · ${formatBytesIec(current)}`],
  };
  if (!drop || current === null) return { visual };
  return {
    visual,
    warning: {
      label: "Smaller than usual",
      value: `${volume} is ${Math.round(drop.drop * 100)}% below its usual ${formatBytesIec(drop.median)}. Check that the source isn't empty or truncated before relying on it.`,
    },
  };
}

"use client";

import type { CustomTooltipProps } from "@tremor/react";
import { CHART_COLORS } from "@/lib/metrics/constants";

/**
 * Color mapping for Tremor charts.
 *
 * Tremor v3 generates Tailwind utility classes from the color strings you pass.
 * It detects "--" in the string and wraps it as an arbitrary value, e.g.
 * `stroke-[var(--metric-cpu)]`. This works with Tailwind v4's native CSS
 * variable support. The actual oklch values live in globals.css under both
 * :root and .dark.
 */
export const TREMOR_METRIC_COLORS = {
  cpu: "var(--metric-cpu)",
  memory: "var(--metric-memory)",
  networkRx: "var(--metric-network-rx)",
  networkTx: "var(--metric-network-tx)",
  networkRxRate: "var(--metric-network-rx)",
  networkTxRate: "var(--metric-network-tx)",
  memoryLimit: "var(--metric-memory-limit)",
  diskTotal: "var(--metric-disk)",
} as const;

/** Maps data keys to the raw oklch color used for tooltip swatches. */
const SWATCH_COLORS: Record<string, string> = {
  cpu: CHART_COLORS.cpu,
  memory: CHART_COLORS.memory,
  networkRx: CHART_COLORS.networkRx,
  networkTx: CHART_COLORS.networkTx,
  networkRxRate: CHART_COLORS.networkRx,
  networkTxRate: CHART_COLORS.networkTx,
  memoryLimit: CHART_COLORS.memoryLimit,
  diskTotal: CHART_COLORS.disk,
};

/**
 * Common props shared by all Tremor AreaCharts across metric views.
 * Apply these as defaults and override per-chart as needed.
 */
export const CHART_DEFAULTS = {
  showLegend: false,
  showAnimation: false,
  showGradient: true,
  showGridLines: true,
  connectNulls: true,
  curveType: "monotone" as const,
  autoMinValue: false,
  minValue: 0,
  yAxisWidth: 80,
} as const;

/**
 * Custom dark-themed tooltip for metric area charts.
 * Replaces Tremor's default light tooltip with one that matches
 * the existing dark card style (oklch-based background, border, text).
 */
export function MetricsTooltip({
  payload,
  active,
  label,
  valueFormatter,
  categoryLabels,
}: CustomTooltipProps & {
  valueFormatter?: (value: number, category: string) => string;
  categoryLabels?: Record<string, string>;
}) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div
      className="rounded-lg border px-3 py-2 text-xs shadow-md"
      style={{
        backgroundColor: "oklch(0.14 0.005 260)",
        borderColor: "oklch(0.25 0.005 260)",
        color: "oklch(0.87 0.005 260)",
      }}
    >
      <p
        className="mb-1.5 font-medium"
        style={{ color: "oklch(0.55 0.005 260)" }}
      >
        {label}
      </p>
      {payload.map((entry) => {
        const category = String(entry.dataKey ?? entry.name ?? "");
        const displayName = categoryLabels?.[category] ?? category;
        const value =
          valueFormatter && typeof entry.value === "number"
            ? valueFormatter(entry.value, category)
            : String(entry.value);

        const swatchColor = SWATCH_COLORS[category] ?? entry.color ?? "#888";

        return (
          <div key={category} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 rounded-full shrink-0"
                style={{ backgroundColor: swatchColor }}
              />
              {displayName}
            </span>
            <span className="tabular-nums font-medium">{value}</span>
          </div>
        );
      })}
    </div>
  );
}

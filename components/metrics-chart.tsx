"use client";

import type { CustomTooltipProps } from "@tremor/react";

/**
 * Color mapping for Tremor charts.
 *
 * Uses Tremor's native Tailwind color names so gradients, fills, and strokes
 * work out of the box without CSS variable hacks.
 */
export const TREMOR_METRIC_COLORS = {
  cpu: "blue",
  memory: "emerald",
  networkRx: "cyan",
  networkTx: "amber",
  networkRxRate: "cyan",
  networkTxRate: "amber",
  memoryLimit: "orange",
  diskTotal: "slate",
} as const;

/**
 * Maps data keys to hex colors for tooltip swatches.
 * These correspond to Tailwind's color-500 values to match what Tremor renders.
 */
const SWATCH_COLORS: Record<string, string> = {
  cpu: "#3b82f6",        // blue-500
  memory: "#10b981",     // emerald-500
  networkRx: "#06b6d4",  // cyan-500
  networkTx: "#f59e0b",  // amber-500
  networkRxRate: "#06b6d4",
  networkTxRate: "#f59e0b",
  memoryLimit: "#f97316", // orange-500
  diskTotal: "#64748b",   // slate-500
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

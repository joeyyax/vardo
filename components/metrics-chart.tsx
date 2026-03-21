"use client";

import { CHART_COLORS } from "@/lib/metrics/constants";

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

type RechartsPayloadEntry = {
  dataKey?: string;
  name?: string;
  value?: number;
  color?: string;
};

type MetricsTooltipProps = {
  active?: boolean;
  payload?: RechartsPayloadEntry[];
  label?: string;
  valueFormatter?: (value: number, category: string) => string;
  categoryLabels?: Record<string, string>;
};

/**
 * Custom dark-themed tooltip for Recharts area charts.
 * oklch-based background, border, and text colors for dark UI consistency.
 */
export function MetricsTooltip({
  payload,
  active,
  label,
  valueFormatter,
  categoryLabels,
}: MetricsTooltipProps) {
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

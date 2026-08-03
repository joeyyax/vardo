"use client";

import { CHART_COLORS } from "@/lib/metrics/constants";

/** Maps data keys to the series token used for tooltip swatches. */
const SWATCH_COLORS: Record<string, string> = {
  cpu: CHART_COLORS.cpu,
  memory: CHART_COLORS.memory,
  networkRx: CHART_COLORS.networkRx,
  networkTx: CHART_COLORS.networkTx,
  networkRxRate: CHART_COLORS.networkRx,
  networkTxRate: CHART_COLORS.networkTx,
  memoryLimit: CHART_COLORS.reference,
  diskTotal: CHART_COLORS.disk,
  gpuUtilization: CHART_COLORS.gpuUtilization,
  gpuMemoryUsed: CHART_COLORS.gpuMemory,
  gpuTemperature: CHART_COLORS.gpuTemperature,
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

/** Tooltip for Recharts area charts. Sits on the popover ground. */
export function MetricsTooltip({
  payload,
  active,
  label,
  valueFormatter,
  categoryLabels,
}: MetricsTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 font-medium text-muted-foreground">{label}</p>
      {payload.map((entry) => {
        const category = String(entry.dataKey ?? entry.name ?? "");
        const displayName = categoryLabels?.[category] ?? category;
        // A null value is a gap in the series, not a zero.
        const value =
          entry.value == null
            ? "—"
            : valueFormatter && typeof entry.value === "number"
              ? valueFormatter(entry.value, category)
              : String(entry.value);

        const swatchColor =
          SWATCH_COLORS[category] ?? entry.color ?? "var(--muted-foreground)";

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

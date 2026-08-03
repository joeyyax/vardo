"use client";

import { CHART_COLORS } from "@/lib/metrics/constants";

/** Maps data keys to the raw oklch color used for tooltip swatches. */
const SWATCH_COLORS: Record<string, string> = {
  cpu: CHART_COLORS.cpu,
  memory: CHART_COLORS.memory,
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
 * Dark-themed tooltip shell shared by every metrics chart.
 * oklch-based background, border, and text colors for dark UI consistency.
 */
export function TooltipFrame({
  label,
  children,
}: {
  label?: React.ReactNode;
  children: React.ReactNode;
}) {
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
      {children}
    </div>
  );
}

/** One swatch-and-value line inside a tooltip. */
export function TooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex items-center gap-1.5">
        <span
          className="size-2 rounded-full shrink-0"
          style={{ backgroundColor: color }}
        />
        {label}
      </span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

/** Custom tooltip for Recharts area charts. */
export function MetricsTooltip({
  payload,
  active,
  label,
  valueFormatter,
  categoryLabels,
}: MetricsTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <TooltipFrame label={label}>
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

        const swatchColor = SWATCH_COLORS[category] ?? entry.color ?? "#888";

        return (
          <TooltipRow key={category} color={swatchColor} label={displayName} value={value} />
        );
      })}
    </TooltipFrame>
  );
}

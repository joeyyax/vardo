"use client";

import { CHART_COLORS } from "@/lib/metrics/constants";

/** Maps data keys to the raw oklch color used for tooltip swatches. */
const SWATCH_COLORS: Record<string, string> = {
  cpu: CHART_COLORS.cpu,
  memory: CHART_COLORS.memory,
  memoryLimit: CHART_COLORS.reference,
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
 * Tooltip shell shared by every metrics chart. Sits on the popover ground.
 */
export function TooltipFrame({
  label,
  children,
}: {
  label?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <p className="mb-1.5 font-medium text-muted-foreground">{label}</p>
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

export type TimeRange = "5m" | "1h" | "6h" | "24h" | "7d";

export const RANGE_MS: Record<TimeRange, number> = {
  "5m": 300000,
  "1h": 3600000,
  "6h": 21600000,
  "24h": 86400000,
  "7d": 604800000,
};

export const BUCKET_MS: Record<TimeRange, number> = {
  "5m": 5000,
  "1h": 30000,
  "6h": 120000,
  "24h": 300000,
  "7d": 1800000,
};

export const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: "5m", value: "5m" },
  { label: "1h", value: "1h" },
  { label: "6h", value: "6h" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
];

/**
 * Series identity, not state. Values are theme tokens so every series has a
 * light and a dark counterpart; definitions live in app/styles/tokens.css.
 * Only legible where a legend, axis or card title names the series.
 */
export const CHART_COLORS = {
  cpu: "var(--chart-cpu)",
  memory: "var(--chart-memory)",
  networkRx: "var(--chart-network-rx)",
  networkTx: "var(--chart-network-tx)",
  disk: "var(--chart-disk)",
  // GPU borrows the hue of the thing it measures — blue is utilization,
  // green is memory, whichever device is reporting.
  gpuUtilization: "var(--chart-cpu)",
  gpuMemory: "var(--chart-memory)",
  gpuTemperature: "var(--chart-gpu-temperature)",
  /** Limits and thresholds. Neutral — a ceiling is not an error. */
  reference: "var(--chart-reference)",
  /** Alias of `reference`, kept for existing call sites. */
  memoryLimit: "var(--chart-reference)",
  grid: "var(--chart-grid)",
  tick: "var(--muted-foreground)",
};

/** Recharts props for a limit or threshold rule — dashed neutral, no hue. */
export const chartReferenceLine = {
  stroke: CHART_COLORS.reference,
  strokeDasharray: "4 4",
  strokeWidth: 1,
};

export const chartTickStyle = { fontSize: 10, fill: CHART_COLORS.tick };

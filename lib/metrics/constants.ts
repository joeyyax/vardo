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

export const CHART_COLORS = {
  cpu: "oklch(0.65 0.19 255)",
  memory: "oklch(0.72 0.17 150)",
  networkRx: "oklch(0.70 0.15 200)",
  networkTx: "oklch(0.75 0.15 75)",
  memoryLimit: "oklch(0.65 0.22 25)",
  disk: "oklch(0.65 0.1 30)",
  grid: "oklch(0.30 0.006 285.75 / 40%)",
  tick: "oklch(0.55 0.006 285.75)",
};

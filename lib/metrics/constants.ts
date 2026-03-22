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

export const chartTooltipStyle = {
  contentStyle: {
    backgroundColor: "oklch(0.14 0.005 260)",
    border: "1px solid oklch(0.25 0.005 260)",
    borderRadius: "8px",
    fontSize: "12px",
    color: "oklch(0.87 0.005 260)",
  },
  itemStyle: { color: "oklch(0.87 0.005 260)" },
  labelStyle: { color: "oklch(0.55 0.005 260)" },
};

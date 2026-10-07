export type ThresholdLevel = "normal" | "warning" | "critical";

/** Critical over 100% of the limit, warning at `warnAtPercent`, else normal. */

export function volumeThreshold(
  sizeBytes: number,
  maxSizeBytes: number,
  warnAtPercent: number,
): ThresholdLevel {
  const percent = Math.round((sizeBytes / maxSizeBytes) * 100);
  if (percent > 100) return "critical";
  if (percent >= warnAtPercent) return "warning";
  return "normal";
}

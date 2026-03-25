export type ThresholdLevel = "normal" | "warning" | "critical";

/**
 * Returns the threshold level for a volume's usage percentage.
 *   - "critical" when usage exceeds 100% of the limit
 *   - "warning"  when usage >= warnAtPercent
 *   - "normal"   otherwise
 */
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

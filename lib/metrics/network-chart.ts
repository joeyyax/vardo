/**
 * Scale and shape math for the diverging network throughput chart.
 *
 * Sent sits above the center line, received below it, on a symmetric axis so
 * zero is always the middle. Bars carry a signed value for plotting and the
 * true rate alongside it, since nothing below the line is a negative quantity.
 */

import { formatBytes, formatBytesShort } from "./format";

/** Container-relative direction labels. Egress is "Sent", ingress is "Received". */
export const NETWORK_LABELS = { sent: "Sent", received: "Received" } as const;

/** Smallest half-range the axis will take, so an idle series still has a scale. */
export const MIN_NETWORK_DOMAIN = 256;

export type NetworkRatePoint = {
  networkRxRate: number | null;
  networkTxRate: number | null;
};

export type NetworkBarPoint = {
  /** Egress in bytes per second. Null means not collected. */
  sentRate: number | null;
  /** Ingress in bytes per second. Null means not collected. */
  receivedRate: number | null;
  /** Plot value above the center line. */
  sent: number | null;
  /** Plot value below the center line, so negative. */
  received: number | null;
};

/** Signed plot values for one sample, preserving null as null rather than zero. */
export function networkBarPoint(point: NetworkRatePoint): NetworkBarPoint {
  const sentRate = point.networkTxRate;
  const receivedRate = point.networkRxRate;
  return {
    sentRate,
    receivedRate,
    sent: sentRate === null ? null : Math.max(0, sentRate),
    received: receivedRate === null ? null : -Math.max(0, receivedRate),
  };
}

export function networkBarPoints(points: NetworkRatePoint[]): NetworkBarPoint[] {
  return points.map(networkBarPoint);
}

/** True when at least one sample carries a rate in either direction. */
export function hasNetworkSamples(points: NetworkBarPoint[]): boolean {
  return points.some((p) => p.sentRate !== null || p.receivedRate !== null);
}

const CEILING_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** Rounds up to a round figure that stays round when halved for the mid tick. */
export function niceRateCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return MIN_NETWORK_DOMAIN;
  const unit = 1024 ** Math.floor(Math.log(value) / Math.log(1024));
  const scaled = value / unit;
  const decade = 10 ** Math.floor(Math.log10(scaled));
  const normalized = scaled / decade;
  const step = CEILING_STEPS.find((s) => normalized <= s) ?? 10;
  return step * decade * unit;
}

/** Symmetric domain around zero, sized to the busiest direction. */
export function networkDomain(points: NetworkBarPoint[]): [number, number] {
  let peak = 0;
  for (const p of points) {
    if (p.sentRate !== null) peak = Math.max(peak, p.sentRate);
    if (p.receivedRate !== null) peak = Math.max(peak, p.receivedRate);
  }
  const max = Math.max(niceRateCeiling(peak), MIN_NETWORK_DOMAIN);
  return [-max, max];
}

/** Five ticks, so the center line is always labeled. */
export function networkTicks(max: number): number[] {
  return [-max, -max / 2, 0, max / 2, max];
}

/** Axis tick. A downward bar is still a positive rate, so the sign is dropped. */
export function formatRateTick(value: number): string {
  if (value === 0) return "0";
  return `${formatBytesShort(Math.abs(value))}/s`;
}

/** Tooltip value. Null reads as absent, zero reads as measured and idle. */
export function formatRateValue(value: number | null): string {
  if (value === null) return "Not collected";
  return `${formatBytes(Math.abs(value))}/s`;
}

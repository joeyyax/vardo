/**
 * Rates from cAdvisor's cumulative byte counters.
 * A counter drop (restart or set change) and the sample after it are reported as unknown.
 */

export type CounterSample = {
  timestamp: number;
  networkRx: number;
  networkTx: number;
};

/** A rate of `null` means unknown — chart it as a gap, never as zero. */
export type NetworkRates = {
  networkRxRate: number | null;
  networkTxRate: number | null;
};

type SeriesState = { prev: number; wasReset: boolean };

function nextRate(
  state: SeriesState | null,
  value: number,
  dtSec: number,
): { rate: number | null; state: SeriesState } {
  if (!state) return { rate: null, state: { prev: value, wasReset: false } };
  if (dtSec <= 0) return { rate: null, state };

  const delta = value - state.prev;
  if (delta < 0) return { rate: null, state: { prev: value, wasReset: true } };
  if (state.wasReset) return { rate: null, state: { prev: value, wasReset: false } };

  return { rate: delta / dtSec, state: { prev: value, wasReset: false } };
}

/** Per-sample receive and send rates in bytes per second, index-aligned to `points`. */
export function networkRates(points: CounterSample[]): NetworkRates[] {
  let rx: SeriesState | null = null;
  let tx: SeriesState | null = null;
  const out: NetworkRates[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dtSec = i > 0 ? (p.timestamp - points[i - 1].timestamp) / 1000 : 0;
    const rxNext = nextRate(rx, p.networkRx, dtSec);
    const txNext = nextRate(tx, p.networkTx, dtSec);
    rx = rxNext.state;
    tx = txNext.state;
    out.push({ networkRxRate: rxNext.rate, networkTxRate: txNext.rate });
  }

  return out;
}

/** Window the stat-card sparklines cover. */
export const CARD_WINDOW_MS = 15 * 60 * 1000;

/** Samples within `windowMs` of the newest one. */
export function recentWindow<T extends { timestamp: number }>(points: T[], windowMs = CARD_WINDOW_MS): T[] {
  const last = points[points.length - 1];
  if (!last) return [];
  return points.filter((p) => p.timestamp >= last.timestamp - windowMs);
}

export type CurrentRate = { rx: number; tx: number; total: number };

/** Total throughput per sample, skipping samples with an unknown rate. */
export function totalRateSeries(points: CounterSample[]): number[] {
  const out: number[] = [];
  for (const r of networkRates(points)) {
    if (r.networkRxRate !== null && r.networkTxRate !== null) out.push(r.networkRxRate + r.networkTxRate);
  }
  return out;
}

/** Newest sample with a known rate in both directions; null when none. */
export function currentNetworkRate(points: CounterSample[]): CurrentRate | null {
  const rates = networkRates(points);
  for (let i = rates.length - 1; i >= 0; i--) {
    const { networkRxRate: rx, networkTxRate: tx } = rates[i];
    if (rx !== null && tx !== null) return { rx, tx, total: rx + tx };
  }
  return null;
}

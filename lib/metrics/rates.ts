/**
 * Rate derivation from the cumulative byte counters cAdvisor reports.
 *
 * A counter only ever climbs while a container lives. It drops when a container
 * restarts or leaves the aggregated set, and the sample after that drop carries
 * the whole counter again — differencing it blindly reports a lifetime's traffic
 * as one second's worth. Both the drop and the recovery are reported as unknown.
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

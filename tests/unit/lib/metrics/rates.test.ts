import { describe, it, expect } from "vitest";
import { networkRates, type CounterSample } from "@/lib/metrics/rates";

const GB = 1024 ** 3;

function sample(seconds: number, rx: number, tx = rx): CounterSample {
  return { timestamp: seconds * 1000, networkRx: rx, networkTx: tx };
}

describe("networkRates", () => {
  it("returns no rate for the first sample", () => {
    const [first] = networkRates([sample(0, 100)]);
    expect(first).toEqual({ networkRxRate: null, networkTxRate: null });
  });

  it("divides the counter delta by elapsed seconds", () => {
    const rates = networkRates([sample(0, 1000), sample(10, 6000)]);
    expect(rates[1].networkRxRate).toBe(500);
    expect(rates[1].networkTxRate).toBe(500);
  });

  it("reports a counter reset as unknown, not a negative rate", () => {
    const rates = networkRates([sample(0, 5 * GB), sample(10, 0)]);
    expect(rates[1].networkRxRate).toBeNull();
  });

  it("suppresses the recovery spike after a reset", () => {
    const rates = networkRates([
      sample(0, 5.5 * GB),
      sample(10, 0),
      sample(20, 5.5 * GB),
      sample(30, 5.5 * GB + 1000),
    ]);
    expect(rates[1].networkRxRate).toBeNull();
    expect(rates[2].networkRxRate).toBeNull();
    expect(rates[3].networkRxRate).toBe(100);
  });

  it("tracks receive and send independently", () => {
    const rates = networkRates([
      { timestamp: 0, networkRx: 1000, networkTx: 1000 },
      { timestamp: 10_000, networkRx: 0, networkTx: 3000 },
    ]);
    expect(rates[1].networkRxRate).toBeNull();
    expect(rates[1].networkTxRate).toBe(200);
  });

  it("returns no rate when two samples share a timestamp", () => {
    const rates = networkRates([sample(5, 1000), sample(5, 2000)]);
    expect(rates[1].networkRxRate).toBeNull();
  });

  it("keeps the previous baseline when time does not advance", () => {
    const rates = networkRates([sample(0, 1000), sample(0, 9000), sample(10, 2000)]);
    expect(rates[2].networkRxRate).toBe(100);
  });

  it("handles an empty series", () => {
    expect(networkRates([])).toEqual([]);
  });
});

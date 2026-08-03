// ---------------------------------------------------------------------------
// One shape for "what is this using, and what is it allowed to use".
//
// A reading never carries a number it did not measure. `usage: null` with an
// `absence` reason is how a metric nobody collects reports itself, so a caller
// cannot render it as 0 B without noticing.
// ---------------------------------------------------------------------------

export type ResourceKind =
  | "cpu"
  | "memory"
  | "disk"
  | "network"
  | "networkRx"
  | "networkTx"
  | "gpu"
  | "gpuMemory"
  | "gpuTemperature"
  | "diskWrite";

export type ResourceUnit = "percent" | "bytes" | "bytesPerSecond" | "celsius";

/** Why a reading has no number. Set exactly when `usage` is null. */
export type Absence =
  /** Nothing on this host measures it. */
  | "not-collected"
  /** Measured before, but no sample inside the freshness window. */
  | "stale"
  /** The subject cannot have this metric at all. */
  | "unsupported";

export type LimitKind =
  /** The kernel caps this subject at `limit`. */
  | "enforced"
  /** Some containers in scope are capped, others run uncapped — `limit` is a floor. */
  | "partial"
  /** A shared ceiling the subject competes for, not a cap on the subject. */
  | "capacity"
  /** No cap exists for this metric. */
  | "none"
  /** A cap may exist; nothing here can read it. */
  | "unknown";

/** A sparkline sample. `null` is a gap, never a zero. */
export type SeriesPoint = [timestamp: number, value: number | null];

export type ResourceReading = {
  kind: ResourceKind;
  unit: ResourceUnit;
  /** Current value, or null when absent. */
  usage: number | null;
  /** Non-null exactly when `usage` is null. */
  absence: Absence | null;
  /** The ceiling, or null when there is none to state. */
  limit: number | null;
  limitKind: LimitKind;
  /** usage as a percentage of limit. Null unless both are known and comparable. */
  percent: number | null;
  /** Oldest first. Empty when no history was requested. */
  series: SeriesPoint[];
};

/** Limit kinds a percentage means something against. */
const MEASURABLE_AGAINST: readonly LimitKind[] = ["enforced", "partial", "capacity"];

export type ReadingInput = {
  kind: ResourceKind;
  unit: ResourceUnit;
  usage?: number | null;
  absence?: Absence | null;
  limit?: number | null;
  limitKind?: LimitKind;
  series?: SeriesPoint[];
};

/**
 * Build a reading. The only place percentage-of-limit is computed, and the only
 * place `usage`/`absence` are reconciled.
 */
export function reading(input: ReadingInput): ResourceReading {
  const usage = input.usage ?? null;
  const absence = usage === null ? (input.absence ?? "not-collected") : null;
  const limitKind = input.limitKind ?? "unknown";
  const limit = limitKind === "none" ? null : (input.limit ?? null);

  return {
    kind: input.kind,
    unit: input.unit,
    usage,
    absence,
    limit,
    limitKind,
    percent: percentOfLimit(usage, limit, limitKind),
    series: input.series ?? [],
  };
}

/** usage/limit as a percentage, or null when the pair says nothing. */
export function percentOfLimit(
  usage: number | null,
  limit: number | null,
  limitKind: LimitKind,
): number | null {
  if (usage === null || limit === null || limit <= 0) return null;
  if (!MEASURABLE_AGAINST.includes(limitKind)) return null;
  return Math.round((usage / limit) * 10000) / 100;
}

/** A reading for something this host does not measure. */
export function notCollected(
  kind: ResourceKind,
  unit: ResourceUnit,
  absence: Absence = "not-collected",
): ResourceReading {
  return reading({ kind, unit, absence, limitKind: "unknown" });
}

/** What the five metrics resolve to for one app or one project. */
export type ResourceSnapshot = {
  subject: { type: "app" | "project"; id: string; name: string };
  /** Distinct containers the readings are built from. */
  containerCount: number;
  /** Newest sample time across every metric, null when nothing is fresh. */
  sampledAt: number | null;
  cpu: ResourceReading;
  memory: ResourceReading;
  disk: ResourceReading;
  network: ResourceReading;
  gpu: ResourceReading;
  /** Secondary readings that pair with a headline metric. */
  extras: {
    networkRx: ResourceReading;
    networkTx: ResourceReading;
    gpuMemory: ResourceReading;
    gpuTemperature: ResourceReading;
    diskWrite: ResourceReading;
  };
};

/** The five headline readings in display order. */
export function headlineReadings(snapshot: ResourceSnapshot): ResourceReading[] {
  return [snapshot.cpu, snapshot.memory, snapshot.disk, snapshot.network, snapshot.gpu];
}

// The per-app signals anomaly detection watches, their floors and how they read in an email.

import { formatBytesIec } from "@/lib/metrics/format";

export type SignalKey = "egress" | "cpu" | "ingress" | "pids" | "diskWrite";

export const SENSITIVITIES = ["low", "normal", "high"] as const;

export type Sensitivity = (typeof SENSITIVITIES)[number];

export type SignalDef = {
  key: SignalKey;
  /** "Outbound traffic". */
  label: string;
  /** Smallest rise over baseline that counts, in the signal's unit, at normal sensitivity. */
  floor: number;
  /** Scales the sensitivity multiplier. Below 1 trips sooner. */
  weight: number;
  /** How long it must stay over the line to fire. */
  sustainMs: number;
  format: (value: number) => string;
};

const MIN = 60_000;
const MiB = 1024 ** 2;

/** Bytes per second as bytes per minute. */
const perMinute = (bytesPerSec: number) => `${formatBytesIec(Math.max(0, bytesPerSec) * 60)}/min`;

function cores(percent: number): string {
  if (percent < 100) return `${Math.round(percent)}% of a core`;
  return `${(percent / 100).toFixed(1)} cores`;
}

/** Egress first: the classic sign of a compromised app. */
export const SIGNALS: Record<SignalKey, SignalDef> = {
  egress: { key: "egress", label: "Outbound traffic", floor: MiB / 60, weight: 0.67, sustainMs: 10 * MIN, format: perMinute },
  cpu: { key: "cpu", label: "CPU", floor: 5, weight: 1, sustainMs: 15 * MIN, format: cores },
  ingress: { key: "ingress", label: "Inbound traffic", floor: (4 * MiB) / 60, weight: 1, sustainMs: 15 * MIN, format: perMinute },
  pids: { key: "pids", label: "Processes", floor: 10, weight: 1, sustainMs: 15 * MIN, format: (n) => `${Math.round(n)}` },
  diskWrite: { key: "diskWrite", label: "Disk writes", floor: (16 * MiB) / 60, weight: 1, sustainMs: 15 * MIN, format: perMinute },
};

export const SIGNAL_KEYS = Object.keys(SIGNALS) as SignalKey[];

/** Multiplier over the baseline's high mark. */
export const SENSITIVITY_K: Record<Sensitivity, number> = { low: 4, normal: 3, high: 2 };

/** Scales each signal's floor. */
export const SENSITIVITY_FLOOR: Record<Sensitivity, number> = { low: 2, normal: 1, high: 0.5 };

export function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (SENSITIVITIES as readonly string[]).includes(value);
}

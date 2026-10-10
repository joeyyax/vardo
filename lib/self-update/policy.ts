// How this instance takes Vardo updates: off, notify or apply them on its own in a maintenance window.

import { z } from "zod";
import { isValidTimeZone, parseClock } from "./window";

export const UPDATE_MODES = ["off", "notify", "auto"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export const UPDATE_CHANNELS = ["main", "releases"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const CANARY_ROLES = ["none", "canary", "follower"] as const;
export type CanaryRole = (typeof CANARY_ROLES)[number];

export type UpdateWindow = {
  /** Local time, `HH:MM`. */
  start: string;
  end: string;
  /** IANA zone. Null uses the instance's time zone. */
  timezone: string | null;
};

export type CanaryPolicy = {
  role: CanaryRole;
  /** Mesh instance id of the canary a follower waits on. */
  canaryInstanceId: string | null;
  /** Hours the canary runs the target healthy before a follower takes it. */
  soakHours: number;
};

export type UpdatePolicy = {
  mode: UpdateMode;
  /** Null follows the mode's default: releases for Auto, main otherwise. */
  channel: UpdateChannel | null;
  window: UpdateWindow;
  canary: CanaryPolicy;
};

export const MAX_SOAK_HOURS = 24 * 14;

export const DEFAULT_POLICY: UpdatePolicy = {
  mode: "notify",
  channel: null,
  window: { start: "03:00", end: "05:00", timezone: null },
  canary: { role: "none", canaryInstanceId: null, soakHours: 24 },
};

export function effectiveChannel(policy: Pick<UpdatePolicy, "mode" | "channel">): UpdateChannel {
  return policy.channel ?? (policy.mode === "auto" ? "releases" : "main");
}

function oneOf<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function clock(raw: unknown, fallback: string): string {
  return typeof raw === "string" && parseClock(raw) !== null ? raw : fallback;
}

/** A stored policy, with anything unreadable replaced by its default. */
export function parsePolicy(raw: unknown): UpdatePolicy {
  if (!raw || typeof raw !== "object") return structuredClone(DEFAULT_POLICY);
  const r = raw as Record<string, unknown>;
  const w = (r.window && typeof r.window === "object" ? r.window : {}) as Record<string, unknown>;
  const c = (r.canary && typeof r.canary === "object" ? r.canary : {}) as Record<string, unknown>;
  const soak = Number(c.soakHours);
  return {
    mode: oneOf(UPDATE_MODES, r.mode, DEFAULT_POLICY.mode),
    channel: r.channel === null || r.channel === undefined ? null : oneOf(UPDATE_CHANNELS, r.channel, "main"),
    window: {
      start: clock(w.start, DEFAULT_POLICY.window.start),
      end: clock(w.end, DEFAULT_POLICY.window.end),
      timezone: typeof w.timezone === "string" && isValidTimeZone(w.timezone) ? w.timezone : null,
    },
    canary: {
      role: oneOf(CANARY_ROLES, c.role, "none"),
      canaryInstanceId: typeof c.canaryInstanceId === "string" && c.canaryInstanceId ? c.canaryInstanceId : null,
      soakHours: Number.isFinite(soak) ? Math.min(MAX_SOAK_HOURS, Math.max(0, Math.round(soak))) : DEFAULT_POLICY.canary.soakHours,
    },
  };
}

const clockSchema = z.string().refine((v) => parseClock(v) !== null, "Use HH:MM");

export const updatePolicySchema = z
  .object({
    mode: z.enum(UPDATE_MODES),
    channel: z.enum(UPDATE_CHANNELS).nullable(),
    window: z.object({
      start: clockSchema,
      end: clockSchema,
      timezone: z
        .string()
        .nullable()
        .refine((v) => v === null || isValidTimeZone(v), "Unknown time zone"),
    }),
    canary: z.object({
      role: z.enum(CANARY_ROLES),
      canaryInstanceId: z.string().min(1).max(128).nullable(),
      soakHours: z.number().int().min(0).max(MAX_SOAK_HOURS),
    }),
  })
  .refine((p) => p.canary.role !== "follower" || p.canary.canaryInstanceId !== null, {
    message: "Pick the canary instance to follow",
    path: ["canary", "canaryInstanceId"],
  });

import { z } from "zod";

export const UPDATE_MODES = ["off", "notify", "auto"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export const UPDATE_CHANNELS = ["main", "releases"] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const ROLLOUT_PRIORITIES = ["critical", "standard", "low"] as const;
export type RolloutPriority = (typeof ROLLOUT_PRIORITIES)[number];

export type UpdatePolicy = {
  mode: UpdateMode;
  priority: RolloutPriority;
  /** Null follows the mode's default: releases for Auto, main otherwise. */
  channel: UpdateChannel | null;
};

export const DEFAULT_POLICY: UpdatePolicy = { mode: "notify", priority: "standard", channel: null };

export function effectiveChannel(policy: Pick<UpdatePolicy, "mode" | "channel">): UpdateChannel {
  return policy.channel ?? (policy.mode === "auto" ? "releases" : "main");
}

function oneOf<T extends string>(values: readonly T[], raw: unknown, fallback: T): T {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? raw as T : fallback;
}

/** Older stored window and canary fields are ignored. */
export function parsePolicy(raw: unknown): UpdatePolicy {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY };
  const value = raw as Record<string, unknown>;
  return {
    mode: oneOf(UPDATE_MODES, value.mode, DEFAULT_POLICY.mode),
    priority: oneOf(ROLLOUT_PRIORITIES, value.priority, DEFAULT_POLICY.priority),
    channel: value.channel == null ? null : oneOf(UPDATE_CHANNELS, value.channel, "main"),
  };
}

export const updatePolicySchema = z.object({
  mode: z.enum(UPDATE_MODES),
  priority: z.enum(ROLLOUT_PRIORITIES),
  channel: z.enum(UPDATE_CHANNELS).nullable(),
});

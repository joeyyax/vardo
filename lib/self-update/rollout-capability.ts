import { effectiveChannel, type RolloutPriority, type UpdateChannel, type UpdateMode, type UpdatePolicy } from "./policy";

export type RolloutCapability = {
  protocol: 1;
  mode: UpdateMode;
  priority: RolloutPriority;
  channel: UpdateChannel;
};

export function rolloutCapability(policy: UpdatePolicy): RolloutCapability {
  return {
    protocol: 1,
    mode: policy.mode,
    priority: policy.priority,
    channel: effectiveChannel(policy),
  };
}

export function parseRolloutCapability(raw: unknown): RolloutCapability | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.protocol !== 1) return null;
  if (value.mode !== "off" && value.mode !== "notify" && value.mode !== "auto") return null;
  if (value.priority !== "critical" && value.priority !== "standard" && value.priority !== "low") return null;
  if (value.channel !== "main" && value.channel !== "releases") return null;
  return value as RolloutCapability;
}

export async function localRolloutCapability(): Promise<RolloutCapability> {
  const { getUpdatePolicy } = await import("./store");
  return rolloutCapability(await getUpdatePolicy());
}

import type { RolloutPriority, UpdateChannel } from "./policy";

export type RolloutMemberState = "waiting" | "busy" | "updating" | "verified" | "skipped" | "failed" | "unreachable";

export type RolloutMember = {
  instanceId: string;
  name: string;
  priority: RolloutPriority;
  state: RolloutMemberState;
  fromSha: string | null;
  reason: string | null;
  busySince: string | null;
  notifiedBusyAt: string | null;
  deploymentId: string | null;
};

export type Rollout = {
  id: string;
  targetSha: string;
  targetLabel: string;
  channel: UpdateChannel;
  startedAt: string;
  finishedAt: string | null;
  state: "running" | "paused" | "completed" | "superseded";
  immediate: boolean;
  pendingSha: string | null;
  notices: string[];
  members: RolloutMember[];
};

const rank: Record<RolloutPriority, number> = { critical: 0, standard: 1, low: 2 };

/** Pick ready members without letting a busy member hold a later priority. */
export function nextReadyMembers(rollout: Rollout, readyIds: ReadonlySet<string>, maxConcurrent: number): RolloutMember[] {
  if (rollout.state !== "running" || rollout.pendingSha) return [];
  const active = rollout.members.filter((member) => member.state === "updating").length;
  const slots = Math.max(0, maxConcurrent - active);
  return rollout.members
    .filter((member) => member.state === "waiting" && readyIds.has(member.instanceId))
    .sort((a, b) => (rollout.immediate ? 0 : rank[a.priority] - rank[b.priority]) || a.name.localeCompare(b.name))
    .slice(0, slots);
}

export function rolloutDone(rollout: Rollout): boolean {
  return rollout.members.every((member) => member.state === "verified" || member.state === "skipped");
}

export function hasRolloutFailure(rollout: Rollout): boolean {
  return rollout.members.some((member) => member.state === "failed" || member.state === "unreachable");
}

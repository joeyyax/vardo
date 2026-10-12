import { recordActivity } from "@/lib/activity";
import { emit } from "@/lib/notifications/dispatch";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import { openIncident, resolveIncidents, safely } from "@/lib/incidents/store";
import { logger } from "@/lib/logger";
import { setRollout } from "./store";
import type { Rollout, RolloutMember } from "./rollout-plan";

const log = logger.child("update-rollout-events");
const INCIDENT = "system.rollout";

export async function recordRolloutAction(
  rollout: Rollout,
  action: string,
  member?: RolloutMember,
  userId?: string,
): Promise<void> {
  try {
    for (const organizationId of await adminOrgIds()) {
      await recordActivity({
        organizationId, action, userId,
        metadata: {
          rolloutId: rollout.id,
          targetSha: rollout.targetSha,
          targetLabel: rollout.targetLabel,
          ...(member ? { instanceId: member.instanceId, name: member.name, reason: member.reason } : {}),
        },
      });
    }
  } catch (error) {
    log.warn("Couldn't record rollout activity:", error);
  }
}

export async function recordMemberChanges(before: Rollout, after: Rollout): Promise<void> {
  const actions: Partial<Record<RolloutMember["state"], string>> = {
    updating: "system.rollout_member_started",
    verified: "system.rollout_member_verified",
    skipped: "system.rollout_member_skipped",
    failed: "system.rollout_member_failed",
    unreachable: "system.rollout_member_unreachable",
  };
  for (const member of after.members) {
    const previous = before.members.find((item) => item.instanceId === member.instanceId);
    if (previous?.state === member.state) continue;
    const action = actions[member.state];
    if (action) await recordRolloutAction(after, action, member);
  }
}

export async function announceRollout(rollout: Rollout, notice: "started" | "busy" | "paused" | "finished", member?: RolloutMember): Promise<void> {
  const key = notice === "busy" ? `busy:${member?.instanceId}` : notice;
  if (rollout.notices.includes(key)) return;
  rollout.notices.push(key);
  if (notice === "busy" && member) member.notifiedBusyAt = new Date().toISOString();
  await setRollout(rollout);
  if (notice === "busy" && member) await recordRolloutAction(rollout, "system.rollout_member_busy", member);
  const type = `system.rollout-${notice}` as const;
  try {
    for (const organizationId of await adminOrgIds()) {
      const now = new Date();
      const incident = notice === "paused"
        ? await safely("open", () => openIncident(organizationId, {
            kind: INCIDENT, about: rollout.id, severity: "critical", title: `Vardo rollout paused at ${rollout.targetLabel}`,
          }, now), null)
        : null;
      if (notice === "finished") await safely("resolve", () => resolveIncidents(organizationId, INCIDENT, [rollout.id], now), new Map());
      emit(organizationId, {
        type,
        title: notice === "started" ? "Vardo rollout started" : notice === "busy" ? "Vardo rollout is waiting" : notice === "paused" ? "Vardo rollout paused" : "Vardo rollout finished",
        message: `Update to ${rollout.targetLabel}: ${notice}`,
        rolloutId: rollout.id,
        targetSha: rollout.targetSha,
        targetLabel: rollout.targetLabel,
        members: rollout.members.map((item) => ({
          instanceId: item.instanceId, name: item.name, priority: item.priority, state: item.state, reason: item.reason,
        })),
        ...(member ? { busyInstanceId: member.instanceId } : {}),
        ...(incident ? { incident } : {}),
      });
    }
  } catch (error) {
    log.error(`Couldn't announce rollout ${notice}:`, error);
  }
}

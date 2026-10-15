import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db";
import { meshPeers } from "@/lib/db/schema";
import { getInstanceId } from "@/lib/constants";
import { getInstanceConfig } from "@/lib/system-settings";
import { HUB_IP } from "@/lib/mesh/ip-allocator";
import { meshSignedPost } from "@/lib/mesh/client";
import { acquireLock, releaseLock } from "@/lib/redis-lock";
import { fetchCompare, getBuildSha, getChannelUpdate } from "@/lib/version";
import { logger } from "@/lib/logger";
import { localRolloutCapability, parseRolloutCapability } from "./rollout-capability";
import { readPeerReadiness, retryPeerRollout, startPeerRollout, type PeerReadiness } from "./rollout-peer";
import { getRollout, setRollout } from "./store";
import { hasRolloutFailure, nextReadyMembers, rolloutDone, type Rollout, type RolloutMember } from "./rollout-plan";
import { sameCommit } from "./commit";
import type { UpdateChannel } from "./policy";
import { announceRollout, closeRolloutIncident, recordMemberChanges, recordRolloutAction } from "./rollout-events";

const log = logger.child("update-rollout");
const LOCK_KEY = "self-update:rollout";
const LOCK_MS = 15 * 60_000;
const MAX_CONCURRENT = 2;
const PATH = "/api/v1/mesh/update-rollout";

type Peer = {
  id: string;
  instanceId: string;
  name: string;
  status: string;
  connectionType: string;
  type: string;
  internalIp: string;
  vardoSha: string | null;
  vardoUpdate: unknown;
};

export async function isRolloutCoordinator(): Promise<boolean> {
  const hub = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.internalIp, HUB_IP),
    columns: { connectionType: true },
  });
  return !hub || hub.connectionType !== "direct";
}

async function membersFor(channel: UpdateChannel): Promise<RolloutMember[]> {
  const [selfId, config, local, peers] = await Promise.all([
    getInstanceId(), getInstanceConfig(), localRolloutCapability(),
    db.query.meshPeers.findMany({
      columns: { id: true, instanceId: true, name: true, status: true, connectionType: true, type: true, internalIp: true, vardoSha: true, vardoUpdate: true },
    }),
  ]);
  const base = (instanceId: string, name: string, priority: RolloutMember["priority"], fromSha: string | null): RolloutMember => ({
    instanceId, name, priority, state: "waiting", fromSha, reason: null, busySince: null, notifiedBusyAt: null, deploymentId: null,
  });
  const members: RolloutMember[] = [];
  if (local.mode === "auto" && local.channel === channel) members.push(base(selfId, config.instanceName, local.priority, getBuildSha()));
  for (const peer of peers as Peer[]) {
    if (peer.connectionType !== "direct" || peer.type !== "persistent") continue;
    const capability = parseRolloutCapability(peer.vardoUpdate);
    if (capability?.mode === "off" || capability?.mode === "notify" || (capability && capability.channel !== channel)) continue;
    const member = base(peer.instanceId, peer.name, capability?.priority ?? "standard", peer.vardoSha);
    if (!capability) {
      member.state = "failed";
      member.reason = "Update protocol isn't available on this instance";
    } else if (peer.status !== "online") {
      member.state = "unreachable";
      member.reason = "Instance is offline";
    }
    members.push(member);
  }
  const order = { critical: 0, standard: 1, low: 2 };
  return members.sort((a, b) => order[a.priority] - order[b.priority] || a.name.localeCompare(b.name));
}

async function membersBehindTarget(members: RolloutMember[], targetSha: string): Promise<RolloutMember[] | null> {
  const checked = await Promise.all(members.map(async (member) => {
    if (sameCommit(member.fromSha, targetSha)) return member;
    if (!member.fromSha) return { ...member, state: "failed" as const, reason: "Build commit is unknown" };
    const compare = await fetchCompare(member.fromSha, targetSha);
    if (!compare) return null;
    if (compare.status === "behind" || compare.status === "identical") return undefined;
    if (compare.status === "diverged") return { ...member, state: "failed" as const, reason: "Build isn't an ancestor of the update" };
    return member;
  }));
  return checked.includes(null) ? null : checked.filter((member): member is RolloutMember => member !== null && member !== undefined);
}

async function peerCall(member: RolloutMember, rollout: Rollout, action: "status" | "start" | "retry"): Promise<PeerReadiness> {
  if (member.instanceId === await getInstanceId()) {
    if (action === "status") return readPeerReadiness(rollout.targetSha, rollout.channel, rollout.id);
    if (action === "start") return startPeerRollout(rollout.targetSha, rollout.targetLabel, rollout.channel, rollout.id);
    return retryPeerRollout(rollout.targetSha, rollout.channel, rollout.id);
  }
  const peer = await db.query.meshPeers.findFirst({
    where: eq(meshPeers.instanceId, member.instanceId),
    columns: { id: true },
  });
  if (!peer) throw new Error("Instance is no longer linked");
  const { data } = await meshSignedPost<PeerReadiness>(peer.id, PATH, {
    action, rolloutId: rollout.id, targetSha: rollout.targetSha, targetLabel: rollout.targetLabel, channel: rollout.channel,
  }, { timeoutMs: action === "start" ? 120_000 : 12_000 });
  return data;
}

function updateMember(member: RolloutMember, report: PeerReadiness, now: Date): RolloutMember {
  const state = report.state === "ready" ? "waiting" : report.state === "blocked" ? "failed" : report.state;
  return {
    ...member,
    state,
    reason: report.reason,
    fromSha: member.fromSha ?? report.sha,
    deploymentId: report.deploymentId ?? member.deploymentId,
    busySince: state === "busy" ? member.busySince ?? now.toISOString() : null,
    notifiedBusyAt: state === "busy" ? member.notifiedBusyAt : null,
  };
}

async function refresh(rollout: Rollout, now: Date): Promise<Rollout> {
  const members = await Promise.all(rollout.members.map(async (member) => {
    if (member.state === "skipped") return member;
    try {
      return updateMember(member, await peerCall(member, rollout, "status"), now);
    } catch (error) {
      return { ...member, state: "unreachable" as const, reason: error instanceof Error ? error.message : "Instance is unreachable" };
    }
  }));
  return { ...rollout, members };
}

async function startReady(rollout: Rollout, now: Date): Promise<Rollout> {
  const ready = new Set(rollout.members.filter((member) => member.state === "waiting").map((member) => member.instanceId));
  const selected = nextReadyMembers(rollout, ready, MAX_CONCURRENT);
  for (const member of selected) {
    try {
      const report = await peerCall(member, rollout, "start");
      rollout.members = rollout.members.map((item) => item.instanceId === member.instanceId ? updateMember(item, report, now) : item);
    } catch (error) {
      // A lost response may mean the update started. The next tick checks before retrying.
      rollout.members = rollout.members.map((item) => item.instanceId === member.instanceId
        ? { ...item, state: "updating", reason: error instanceof Error ? error.message : "Checking update status" }
        : item);
    }
    await setRollout(rollout);
  }
  return rollout;
}

export class RolloutActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RolloutActionError";
  }
}

type Verdict = "past" | "behind" | "unknown";

async function supersede(rollout: Rollout, now: Date, by?: { action: string; userId: string }): Promise<void> {
  rollout.state = "superseded";
  rollout.finishedAt = now.toISOString();
  await setRollout(rollout);
  await recordRolloutAction(rollout, by?.action ?? "system.rollout_superseded", undefined, by?.userId);
  await closeRolloutIncident(rollout);
}

/** Where each failed or unreachable member stands against the target, from its live build. */
async function judgeFailedMembers(rollout: Rollout): Promise<Map<string, Verdict>> {
  const entries = await Promise.all(rollout.members
    .filter((member) => member.state === "failed" || member.state === "unreachable")
    .map(async (member): Promise<[string, Verdict]> => {
      try {
        const { sha } = await peerCall(member, rollout, "status");
        if (sameCommit(sha, rollout.targetSha)) return [member.instanceId, "past"];
        const compare = await fetchCompare(sha, rollout.targetSha);
        if (!compare) return [member.instanceId, "unknown"];
        return [member.instanceId, compare.status === "behind" || compare.status === "identical" ? "past" : "behind"];
      } catch {
        return [member.instanceId, "unknown"];
      }
    }));
  return new Map(entries);
}

function allPast(verdicts: Map<string, Verdict>): boolean {
  return verdicts.size > 0 && [...verdicts.values()].every((verdict) => verdict === "past");
}

/** Clears a paused rollout once the channel moved on or every failed member is at or past the target. */
async function settlePaused(rollout: Rollout, update: { targetSha: string } | null, now: Date): Promise<void> {
  if (update && !sameCommit(update.targetSha, rollout.targetSha)) return supersede(rollout, now);
  if (allPast(await judgeFailedMembers(rollout))) await supersede(rollout, now);
}

/** Failed or unreachable members whose instance is no longer linked to this hub. */
export async function unlinkedMemberIds(rollout: Rollout): Promise<string[]> {
  const stuck = rollout.members.filter((member) => member.state === "failed" || member.state === "unreachable");
  if (!stuck.length) return [];
  const [selfId, peers] = await Promise.all([getInstanceId(), db.query.meshPeers.findMany({ columns: { instanceId: true } })]);
  const linked = new Set([selfId, ...peers.map((peer) => peer.instanceId)]);
  return stuck.filter((member) => !linked.has(member.instanceId)).map((member) => member.instanceId);
}

async function runTick(now: Date): Promise<void> {
  if (!(await isRolloutCoordinator())) return;
  const [local, peers, stored] = await Promise.all([
    localRolloutCapability(),
    db.query.meshPeers.findMany({
      columns: { connectionType: true, type: true, vardoUpdate: true },
    }),
    getRollout(),
  ]);
  // Old peers can't obey the coordinator. Wait until every linked instance speaks this protocol.
  if ((!stored || stored.state === "completed" || stored.state === "superseded")
    && peers.some((peer) => peer.connectionType === "direct" && peer.type === "persistent" && !parseRolloutCapability(peer.vardoUpdate))) return;
  const channels = new Set<UpdateChannel>();
  if (local.mode === "auto") channels.add(local.channel);
  for (const peer of peers) {
    if (peer.connectionType !== "direct" || peer.type !== "persistent") continue;
    const report = parseRolloutCapability(peer.vardoUpdate);
    if (report?.mode === "auto") channels.add(report.channel);
  }
  if (channels.size === 0 && !stored) return;
  const active = stored?.state === "running" || stored?.state === "paused";
  let channel: UpdateChannel | undefined;
  let update: Awaited<ReturnType<typeof getChannelUpdate>> = null;
  let initialMembers: RolloutMember[] | undefined;
  if (active) {
    channel = stored.channel;
    update = await getChannelUpdate(channel);
  } else {
    for (const candidate of channels) {
      const candidateUpdate = await getChannelUpdate(candidate);
      if (!candidateUpdate) continue;
      if (stored?.state === "completed" && stored.channel === candidate && sameCommit(stored.targetSha, candidateUpdate.targetSha)) continue;
      const candidateMembers = await membersFor(candidate);
      if (!candidateMembers.length) continue;
      const outdatedMembers = await membersBehindTarget(candidateMembers, candidateUpdate.targetSha);
      if (!outdatedMembers?.length || outdatedMembers.every((member) => sameCommit(member.fromSha, candidateUpdate.targetSha))) continue;
      channel = candidate;
      update = candidateUpdate;
      initialMembers = outdatedMembers;
      break;
    }
  }
  if (!channel) return;
  let rollout = stored;
  if (!rollout || rollout.state === "completed" || rollout.state === "superseded") {
    if (!update || !initialMembers) return;
    rollout = {
      id: nanoid(), targetSha: update.targetSha, targetLabel: update.targetLabel, channel,
      startedAt: now.toISOString(), finishedAt: null, state: "running", immediate: false, pendingSha: null, notices: [], members: initialMembers,
    };
    if (hasRolloutFailure(rollout)) rollout.state = "paused";
    await setRollout(rollout);
    log.info(`Rollout ${rollout.id} to ${rollout.targetLabel} started`);
    await recordRolloutAction(rollout, "system.rollout_started");
    if (rollout.state === "paused") {
      await recordRolloutAction(rollout, "system.rollout_paused");
      await announceRollout(rollout, "paused");
    }
  }
  if (rollout.state === "paused") return settlePaused(rollout, update, now);
  if (rollout.state !== "running") return;
  if (update && !sameCommit(update.targetSha, rollout.targetSha)) rollout.pendingSha = update.targetSha;
  const beforeRefresh = rollout;
  rollout = await refresh(rollout, now);
  await setRollout(rollout);
  await recordMemberChanges(beforeRefresh, rollout);
  if (hasRolloutFailure(rollout)) {
    rollout.state = "paused";
    await setRollout(rollout);
    await recordRolloutAction(rollout, "system.rollout_paused");
    await announceRollout(rollout, "paused");
    return;
  }
  await announceRollout(rollout, "started");
  for (const member of busyMembersNeedingNotice(rollout, now.getTime())) {
    await announceRollout(rollout, "busy", member);
  }
  if (rollout.pendingSha) {
    if (!rollout.members.some((member) => member.state === "updating")) {
      await supersede(rollout, now);
      return;
    }
    await setRollout(rollout);
    return;
  }
  if (rolloutDone(rollout)) {
    rollout.state = "completed";
    rollout.finishedAt = now.toISOString();
    await setRollout(rollout);
    await recordRolloutAction(rollout, "system.rollout_completed");
    await announceRollout(rollout, "finished");
  } else {
    const beforeStart = { ...rollout, members: rollout.members.map((member) => ({ ...member })) };
    rollout = await startReady(rollout, now);
    await recordMemberChanges(beforeStart, rollout);
  }
  await setRollout(rollout);
}

export async function tickRollout(now = new Date()): Promise<void> {
  const lock = await acquireLock(LOCK_KEY, LOCK_MS);
  if (!lock) return;
  try {
    await runTick(now);
  } finally {
    await releaseLock(LOCK_KEY, lock).catch(() => {});
  }
}

export async function actOnRollout(action: "immediate" | "skip" | "retry" | "dismiss", rolloutId: string, userId: string, instanceId?: string): Promise<Rollout> {
  const lock = await acquireLock(LOCK_KEY, LOCK_MS);
  if (!lock) throw new RolloutActionError("The rollout is busy; try again shortly");
  try {
    const rollout = await getRollout();
    if (!rollout || rollout.id !== rolloutId) throw new RolloutActionError("This rollout has changed");
    if (action === "immediate") {
      if (rollout.state !== "running") throw new RolloutActionError("The rollout isn't running");
      if (rollout.immediate) return rollout;
      rollout.immediate = true;
    } else if (action === "dismiss") {
      if (rollout.state !== "paused") throw new RolloutActionError("Only a paused rollout can be dismissed");
      await supersede(rollout, new Date(), { action: "system.rollout_dismissed", userId });
      return rollout;
    } else if (action === "skip") {
      if (!instanceId) throw new RolloutActionError("Choose an instance to skip");
      const member = rollout.members.find((item) => item.instanceId === instanceId);
      if (member?.state === "skipped") return rollout;
      if (!member) throw new RolloutActionError("That instance isn't in this rollout");
      const stuck = member.state === "failed" || member.state === "unreachable";
      if (member.state !== "busy" && !(stuck && (await unlinkedMemberIds(rollout)).includes(instanceId))) {
        throw new RolloutActionError("Only a busy or unlinked instance can be skipped");
      }
      member.state = "skipped";
      member.reason = "Skipped by an operator for this rollout";
      if (rollout.state === "paused" && !hasRolloutFailure(rollout)) rollout.state = "running";
    } else {
      if (rollout.state === "running") return rollout;
      if (rollout.state !== "paused") throw new RolloutActionError("The rollout isn't paused");
      const verdicts = await judgeFailedMembers(rollout);
      if (allPast(verdicts)) {
        await supersede(rollout, new Date());
        return rollout;
      }
      rollout.members = await Promise.all(rollout.members.map(async (member): Promise<RolloutMember> => {
        const verdict = verdicts.get(member.instanceId);
        if (!verdict) return member;
        if (verdict === "past") return { ...member, state: "skipped", reason: "Already past this target" };
        if (verdict === "unknown") return { ...member, state: "unreachable", reason: "Couldn't check this instance's version" };
        if (member.state === "unreachable") return { ...member, state: "waiting", reason: null };
        try {
          await peerCall(member, rollout, "retry");
          return { ...member, state: "waiting", reason: null };
        } catch (error) {
          return { ...member, state: "unreachable", reason: error instanceof Error ? error.message : "Instance is unreachable" };
        }
      }));
      rollout.state = "running";
    }
    await setRollout(rollout);
    await recordRolloutAction(rollout, action === "immediate" ? "system.rollout_immediate" : action === "skip" ? "system.rollout_member_skipped" : "system.rollout_retried", action === "skip" ? rollout.members.find((member) => member.instanceId === instanceId) : undefined, userId);
    return rollout;
  } finally {
    await releaseLock(LOCK_KEY, lock).catch(() => {});
  }
}

export function busyMembersNeedingNotice(rollout: Rollout, now = Date.now()): RolloutMember[] {
  const configured = Number(process.env.VARDO_UPDATE_BUSY_ALERT_MINUTES ?? 60);
  const busyNoticeMs = (Number.isFinite(configured) && configured > 0 ? configured : 60) * 60_000;
  return rollout.members.filter((member) => member.state === "busy" && member.busySince
    && !member.notifiedBusyAt && now - Date.parse(member.busySince) >= busyNoticeMs);
}

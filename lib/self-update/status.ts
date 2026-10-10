// Everything the admin Updates card shows, in one read.

import pkg from "@/package.json";
import { db } from "@/lib/db";
import { isSelfDeployLayout } from "@/lib/paths";
import { formatVersion } from "@/lib/lifecycle/self-deploy";
import { getBuildSha, getChannelUpdate, type ChannelUpdate } from "@/lib/version";
import type { CanaryVerdict } from "./canary";
import { effectiveChannel, type UpdateChannel, type UpdatePolicy } from "./policy";
import { isRunActive } from "./decide";
import { canaryStatus } from "./runner";
import { getUpdatePolicy, getUpdateRun, getUpdateState, type UpdateRun, type UpdateState } from "./store";
import { getInstanceTimezone } from "./timezone";
import { inWindow, nextWindowOpen, windowZone } from "./window";

export type UpdatePeer = {
  instanceId: string;
  name: string;
  sha: string | null;
  since: string | null;
  healthy: boolean | null;
  lastSeenAt: string | null;
};

export type UpdateStatus = {
  selfDeploy: boolean;
  current: { version: string; sha: string };
  policy: UpdatePolicy;
  channel: UpdateChannel;
  update: ChannelUpdate | null;
  run: UpdateRun | null;
  runActive: boolean;
  approval: UpdateState["approval"];
  instanceTimezone: string | null;
  zone: string;
  windowOpen: boolean;
  nextWindowAt: string | null;
  canary: CanaryVerdict | null;
  peers: UpdatePeer[];
  /** The host command for a legacy install. */
  hostCommand: string;
};

async function listPeers(): Promise<UpdatePeer[]> {
  try {
    const rows = await db.query.meshPeers.findMany({
      columns: { instanceId: true, name: true, vardoSha: true, vardoShaSince: true, vardoHealthy: true, lastSeenAt: true },
    });
    return rows.map((p) => ({
      instanceId: p.instanceId,
      name: p.name,
      sha: p.vardoSha,
      since: p.vardoShaSince?.toISOString() ?? null,
      healthy: p.vardoHealthy,
      lastSeenAt: p.lastSeenAt?.toISOString() ?? null,
    }));
  } catch {
    return [];
  }
}

export async function getUpdateStatus(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  const now = new Date();
  const [policy, state, run, instanceTimezone, peers] = await Promise.all([
    getUpdatePolicy(),
    getUpdateState(),
    getUpdateRun(),
    getInstanceTimezone(),
    listPeers(),
  ]);
  const channel = effectiveChannel(policy);
  const update = await getChannelUpdate(channel, opts);
  const zone = windowZone(policy.window.timezone, instanceTimezone);
  const sha = getBuildSha();
  return {
    selfDeploy: isSelfDeployLayout(),
    current: { version: formatVersion(pkg.version, sha) ?? pkg.version, sha },
    policy,
    channel,
    update,
    run,
    runActive: isRunActive(run),
    approval: state.approval,
    instanceTimezone,
    zone,
    windowOpen: inWindow(now, policy.window, zone),
    nextWindowAt: nextWindowOpen(now, policy.window, zone)?.toISOString() ?? null,
    canary: update?.hasUpdate ? await canaryStatus(policy, update.targetSha, state, now) : null,
    peers,
    hostCommand: "sudo vardo update",
  };
}

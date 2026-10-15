import pkg from "@/package.json";
import { db } from "@/lib/db";
import { isSelfDeployLayout } from "@/lib/paths";
import { formatVersion } from "@/lib/lifecycle/self-deploy";
import { getGitHubCheckError, type GitHubCheckError } from "@/lib/github-api";
import { getBuildSha, getChannelCheck, type ChannelUpdate } from "@/lib/version";
import { effectiveChannel, type UpdateChannel, type UpdatePolicy } from "./policy";
import { isRunActive } from "./decide";
import { activeUpdate, type ActiveUpdate } from "./lifecycle";
import { getRollout, getUpdatePolicy, getUpdateRun, type UpdateRun } from "./store";
import type { Rollout } from "./rollout-plan";
import { isRolloutCoordinator, unlinkedMemberIds } from "./coordinator";
import { parseRolloutCapability } from "./rollout-capability";

export type UpdateStatus = {
  selfDeploy: boolean;
  current: { version: string; sha: string };
  policy: UpdatePolicy;
  channel: UpdateChannel;
  update: ChannelUpdate | null;
  /** The releases channel has nothing published yet. */
  noRelease: boolean;
  /** Why the last GitHub check failed. Null when it worked. */
  checkError: GitHubCheckError | null;
  run: UpdateRun | null;
  runActive: boolean;
  active: ActiveUpdate | null;
  rollout: Rollout | null;
  rolloutCoordinator: boolean;
  /** Stuck rollout members whose instance is no longer linked. */
  unlinkedMembers: string[];
  protocolReady: boolean;
  hostCommand: string;
};

export async function getUpdateStatus(opts: { fresh?: boolean } = {}): Promise<UpdateStatus> {
  const [policy, run, active, rollout, rolloutCoordinator, peers] = await Promise.all([
    getUpdatePolicy(),
    getUpdateRun(),
    activeUpdate().catch(() => null),
    getRollout(),
    isRolloutCoordinator(),
    db.query.meshPeers.findMany({ columns: { connectionType: true, type: true, vardoUpdate: true } }),
  ]);
  const unlinkedMembers = rollout && rolloutCoordinator ? await unlinkedMemberIds(rollout) : [];
  const channel = effectiveChannel(policy);
  const { update, noRelease } = await getChannelCheck(channel, opts);
  const sha = getBuildSha();
  return {
    selfDeploy: isSelfDeployLayout(),
    current: { version: formatVersion(pkg.version, sha) ?? pkg.version, sha },
    policy, channel, update, noRelease, checkError: update || noRelease ? null : getGitHubCheckError(), run, runActive: isRunActive(run), active,
    rollout, rolloutCoordinator, unlinkedMembers,
    protocolReady: peers.every((peer) => peer.connectionType !== "direct" || peer.type !== "persistent" || !!parseRolloutCapability(peer.vardoUpdate)),
    hostCommand: "sudo vardo update",
  };
}

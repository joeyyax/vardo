import { fetchCompare, getBuildSha, type ChannelUpdate } from "@/lib/version";
import { isSelfDeployLayout } from "@/lib/paths";
import { evaluateGates } from "./gates";
import { sameCommit } from "./commit";
import { effectiveChannel, type UpdateChannel } from "./policy";
import { collectGateInputs, startUpdate } from "./runner";
import { getUpdatePolicy, getUpdateRun, getUpdateState, setUpdateRun, updateState } from "./store";
import { isRunActive } from "./decide";

export type PeerReadiness = {
  state: "ready" | "busy" | "updating" | "verified" | "blocked";
  sha: string;
  reason: string | null;
  deploymentId: string | null;
};

export async function readPeerReadiness(targetSha: string, channel: UpdateChannel, rolloutId: string): Promise<PeerReadiness> {
  const sha = getBuildSha();
  const [policy, run, state] = await Promise.all([getUpdatePolicy(), getUpdateRun(), getUpdateState()]);
  if (policy.mode !== "auto") return { state: "blocked", sha, reason: "Automatic updates are off here", deploymentId: null };
  if (effectiveChannel(policy) !== channel) return { state: "blocked", sha, reason: "Update channels differ", deploymentId: null };
  if (!isSelfDeployLayout()) return { state: "blocked", sha, reason: "This instance needs self-deploy", deploymentId: null };
  if (run?.rolloutId === rolloutId) {
    if (isRunActive(run)) return { state: "updating", sha, reason: null, deploymentId: run.deploymentId };
    if (run.state === "failed" || run.state === "rolled-back" || run.state === "rollback-failed") {
      return { state: "blocked", sha, reason: run.error ?? `Update ${run.state}`, deploymentId: run.deploymentId };
    }
  }
  if (isRunActive(run)) return { state: "busy", sha, reason: "Another update is running", deploymentId: run?.deploymentId ?? null };

  // A failed compare doesn't block the update.
  if (!sameCommit(sha, targetSha) && (await fetchCompare(sha, targetSha))?.status === "behind") {
    return { state: "verified", sha, reason: "Already past this target", deploymentId: null };
  }

  const gates = evaluateGates(await collectGateInputs(targetSha, state));
  const blocking = gates.filter((failure) => failure.gate !== "busy");
  if (blocking.length) return { state: "blocked", sha, reason: blocking.map((failure) => failure.reason).join("; "), deploymentId: null };
  if (sameCommit(sha, targetSha)) return { state: "verified", sha, reason: null, deploymentId: run?.rolloutId === rolloutId ? run.deploymentId : null };
  if (gates.length) return { state: "busy", sha, reason: gates.map((failure) => failure.reason).join("; "), deploymentId: null };
  return { state: "ready", sha, reason: null, deploymentId: null };
}

export async function startPeerRollout(targetSha: string, targetLabel: string, channel: UpdateChannel, rolloutId: string): Promise<PeerReadiness> {
  const existing = await readPeerReadiness(targetSha, channel, rolloutId);
  if (existing.state !== "ready") return existing;
  const update: ChannelUpdate = {
    channel, localSha: existing.sha, targetSha, targetLabel, commitsBehind: null, hasUpdate: true,
    url: channel === "releases" ? "https://github.com/joeyyax/vardo/releases" : "https://github.com/joeyyax/vardo/commits/main",
  };
  const run = await startUpdate({ trigger: "auto", channel, update, rolloutId });
  return { state: "updating", sha: existing.sha, reason: null, deploymentId: run.deploymentId };
}

export async function retryPeerRollout(targetSha: string, channel: UpdateChannel, rolloutId: string): Promise<PeerReadiness> {
  const [policy, run] = await Promise.all([getUpdatePolicy(), getUpdateRun()]);
  if (policy.mode !== "auto" || effectiveChannel(policy) !== channel) throw new Error("This instance isn't enrolled in the rollout");
  if (isRunActive(run)) throw new Error("An update is still running here");
  await updateState((state) => ({ ...state, failedTargets: state.failedTargets.filter((sha) => !sameCommit(sha, targetSha)) }));
  if (run?.rolloutId === rolloutId) await setUpdateRun({ ...run, rolloutId: undefined });
  return readPeerReadiness(targetSha, channel, rolloutId);
}

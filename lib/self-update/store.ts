// Update policy and run state in system_settings. Reads skip the settings cache: two consoles share them mid-update.

import { getSystemSettingRaw, invalidateSettingsCache, setSystemSetting } from "@/lib/system-settings";
import type { RunState } from "./decide";
import { parsePolicy, type UpdatePolicy } from "./policy";
import type { Rollout } from "./rollout-plan";

const POLICY_KEY = "self_update_policy";
const RUN_KEY = "self_update_run";
const STATE_KEY = "self_update_state";
const ROLLOUT_KEY = "self_update_rollout";

export type UpdateRun = {
  id: string;
  trigger: "auto" | "manual";
  triggeredBy?: string;
  state: RunState;
  startedAt: string;
  finishedAt?: string;
  deploymentId: string;
  /** Last successful deploy of the app before this one: the rollback target. */
  previousDeploymentId: string | null;
  fromSha: string;
  /** Pinned commit, or null when the deploy takes the branch tip. */
  toSha: string | null;
  toLabel: string;
  channel: "main" | "releases";
  dumpFile: string | null;
  verifyStartedAt?: string;
  passes?: number;
  fails?: number;
  rollbackDeploymentId?: string;
  error?: string;
  rolloutId?: string;
};

export type UpdateState = {
  /** Commits that failed post-update checks here. Auto skips them. */
  failedTargets: string[];
  /** When this instance started running its commit. */
  versionSince: { sha: string; since: string } | null;
};

const EMPTY_STATE: UpdateState = { failedTargets: [], versionSince: null };

async function readJson(key: string): Promise<unknown> {
  invalidateSettingsCache(key);
  const raw = await getSystemSettingRaw(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function getUpdatePolicy(): Promise<UpdatePolicy> {
  return parsePolicy(await readJson(POLICY_KEY));
}

export async function setUpdatePolicy(policy: UpdatePolicy): Promise<void> {
  await setSystemSetting(POLICY_KEY, JSON.stringify(policy));
}

export async function getUpdateRun(): Promise<UpdateRun | null> {
  const run = await readJson(RUN_KEY);
  return run && typeof run === "object" && "deploymentId" in run ? (run as UpdateRun) : null;
}

export async function setUpdateRun(run: UpdateRun): Promise<void> {
  await setSystemSetting(RUN_KEY, JSON.stringify(run));
}

export async function getUpdateState(): Promise<UpdateState> {
  const raw = await readJson(STATE_KEY);
  return raw && typeof raw === "object" ? { ...EMPTY_STATE, ...(raw as Partial<UpdateState>) } : { ...EMPTY_STATE };
}

export async function updateState(change: (s: UpdateState) => UpdateState): Promise<UpdateState> {
  const next = change(await getUpdateState());
  await setSystemSetting(STATE_KEY, JSON.stringify(next));
  return next;
}

export async function getRollout(): Promise<Rollout | null> {
  const raw = await readJson(ROLLOUT_KEY);
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Partial<Rollout>;
  if (typeof record.id !== "string" || typeof record.targetSha !== "string" || !Array.isArray(record.members)) return null;
  return record as Rollout;
}

export async function setRollout(rollout: Rollout): Promise<void> {
  await setSystemSetting(ROLLOUT_KEY, JSON.stringify(rollout));
}

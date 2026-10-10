// Update policy and run state in system_settings. Reads skip the settings cache: two consoles share them mid-update.

import { getSystemSettingRaw, invalidateSettingsCache, setSystemSetting } from "@/lib/system-settings";
import type { RunState } from "./decide";
import { parsePolicy, type UpdatePolicy } from "./policy";

const POLICY_KEY = "self_update_policy";
const RUN_KEY = "self_update_run";
const STATE_KEY = "self_update_state";

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
};

export type UpdateState = {
  /** Commits that failed post-update checks here. Auto skips them. */
  failedTargets: string[];
  /** A follower's admin approval of one target. */
  approval: { sha: string; by: string; at: string } | null;
  /** The last skip notice, so one reason sends once per target. */
  lastSkip: { sha: string; key: string; at: string } | null;
  /** When this instance started running its commit. */
  versionSince: { sha: string; since: string } | null;
};

const EMPTY_STATE: UpdateState = { failedTargets: [], approval: null, lastSkip: null, versionSince: null };

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

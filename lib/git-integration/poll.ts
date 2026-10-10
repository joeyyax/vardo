// Polling fallback for auto-deploy: compare each app's branch head with what it last deployed.

import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, deployments } from "@/lib/db/schema";
import { getSystemSettingRaw, setSystemSetting } from "@/lib/system-settings";
import { gitUrlHost } from "@/lib/api/git-fields";

export const POLL_INTERVAL_KEY = "git_poll_interval_minutes";
export const DEFAULT_POLL_INTERVAL_MINUTES = 5;
export const POLL_INTERVAL_CHOICES = [0, 1, 2, 5, 10, 15, 30, 60] as const;

/** Minutes between checks of each app. 0 is off. */
export async function getPollIntervalMinutes(): Promise<number> {
  const raw = await getSystemSettingRaw(POLL_INTERVAL_KEY).catch(() => null);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : DEFAULT_POLL_INTERVAL_MINUTES;
}

export async function setPollIntervalMinutes(minutes: number): Promise<void> {
  await setSystemSetting(POLL_INTERVAL_KEY, String(minutes));
}

export type PollInput = {
  parked: boolean;
  status: string;
  inFlight: boolean | "unknown";
  remoteSha: string;
  lastDeployedSha: string | null;
  /** Last head the poller deployed or recorded as the baseline. */
  polledSha: string | null;
  /** Any deploy of this app, in any state, already carries remoteSha. */
  shaHasDeployment: boolean;
};

export type PollDecision =
  | { action: "deploy" }
  | { action: "baseline" }
  | { action: "skip"; reason: string };

/** What a poll does with a head it just read. */
export function decidePoll(input: PollInput): PollDecision {
  if (input.parked) return { action: "skip", reason: "parked" };
  if (input.status === "stopped") return { action: "skip", reason: "stopped" };
  if (input.inFlight !== false) return { action: "skip", reason: "deploy in flight" };
  if (input.remoteSha === input.lastDeployedSha) return { action: "skip", reason: "up to date" };
  // Already tried: a failure on this SHA isn't retried until the branch moves.
  if (input.remoteSha === input.polledSha) return { action: "skip", reason: "already handled" };
  if (input.shaHasDeployment) return { action: "skip", reason: "already deployed or attempted" };
  if (!input.lastDeployedSha && !input.polledSha) return { action: "baseline" };
  return { action: "deploy" };
}

/** Per-host backoff after a git host errors: doubles from the interval, capped at an hour. */
export class HostBackoff {
  private hosts = new Map<string, { failures: number; until: number }>();

  constructor(private readonly maxMs = 60 * 60_000) {}

  blocked(host: string, now = Date.now()): boolean {
    const entry = this.hosts.get(host);
    return !!entry && now < entry.until;
  }

  failed(host: string, intervalMs: number, now = Date.now()): number {
    const failures = (this.hosts.get(host)?.failures ?? 0) + 1;
    const delay = Math.min(intervalMs * 2 ** (failures - 1), this.maxMs);
    this.hosts.set(host, { failures, until: now + delay });
    return delay;
  }

  succeeded(host: string): void {
    this.hosts.delete(host);
  }

  reset(): void {
    this.hosts.clear();
  }
}

export const hostOf = (gitUrl: string): string => gitUrlHost(gitUrl) ?? "unknown";

export type DeployHistory = { lastDeployedSha: string | null; shaHasDeployment: boolean; queuedOrRunning: boolean };

/** The newest successful deploy's SHA, whether any deploy already carries `sha`, and whether one is queued or running. */
export async function deployHistory(appId: string, sha: string): Promise<DeployHistory> {
  const [last, same, active] = await Promise.all([
    db.query.deployments.findFirst({
      where: and(eq(deployments.appId, appId), eq(deployments.status, "success"), isNotNull(deployments.gitSha)),
      orderBy: [desc(deployments.startedAt)],
      columns: { gitSha: true },
    }),
    db.query.deployments.findFirst({
      where: and(eq(deployments.appId, appId), eq(deployments.gitSha, sha)),
      columns: { id: true },
    }),
    db.query.deployments.findFirst({
      where: and(eq(deployments.appId, appId), inArray(deployments.status, ["queued", "running"])),
      columns: { id: true },
    }),
  ]);
  return { lastDeployedSha: last?.gitSha ?? null, shaHasDeployment: !!same, queuedOrRunning: !!active };
}

export async function recordPoll(appId: string, values: { sha?: string; error: string | null }): Promise<void> {
  await db
    .update(apps)
    .set({
      gitPolledAt: new Date(),
      gitPollError: values.error ? values.error.slice(0, 500) : null,
      ...(values.sha ? { gitPolledSha: values.sha } : {}),
    })
    .where(eq(apps.id, appId));
}

// Runs the integration permission check on startup, daily, after a refused request and on demand.

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { apps, notificationSends } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { issueCopy, type IntegrationIssue, type RaisedIssue } from "./issues";
import { createRechecker, ISSUE_TYPE, syncIssues, type IssueStore, type OpenIssue, type SyncResult } from "./sync";

const log = logger.child("integration-check");

const DAY_MS = 24 * 60 * 60 * 1000;
/** Startup waits this long so boot work goes first. */
const STARTUP_DELAY_MS = 60_000;
/** A refused request rechecks after this, at most once per interval. */
const RECHECK_DELAY_MS = 30_000;
const RECHECK_MIN_INTERVAL_MS = 10 * 60_000;

export const dbIssueStore: IssueStore = {
  async listOpen() {
    const rows = await db
      .select({ organizationId: notificationSends.organizationId, about: notificationSends.about, detail: notificationSends.detail })
      .from(notificationSends)
      .where(and(eq(notificationSends.type, ISSUE_TYPE), isNull(notificationSends.clearedAt)));
    return rows as OpenIssue[];
  },
  async open(organizationId, stored, now) {
    const rows = await db
      .insert(notificationSends)
      .values({ organizationId, type: ISSUE_TYPE, about: stored.issue.key, severity: "warning", sentAt: now, detail: stored })
      .onConflictDoUpdate({
        target: [notificationSends.organizationId, notificationSends.type, notificationSends.about],
        set: { sentAt: now, clearedAt: null, detail: stored },
        setWhere: sql`${notificationSends.clearedAt} is not null or ${notificationSends.detail}->>'fingerprint' is distinct from ${stored.fingerprint}`,
      })
      .returning({ about: notificationSends.about });
    return rows.length > 0;
  },
  async close(organizationId, abouts, now) {
    if (abouts.length === 0) return;
    await db
      .update(notificationSends)
      .set({ clearedAt: now })
      .where(
        and(
          eq(notificationSends.organizationId, organizationId),
          eq(notificationSends.type, ISSUE_TYPE),
          inArray(notificationSends.about, abouts),
          isNull(notificationSends.clearedAt),
        ),
      );
  },
};

async function notify(organizationId: string, issue: IntegrationIssue): Promise<void> {
  const { emit } = await import("@/lib/notifications/dispatch");
  const copy = issueCopy(issue);
  emit(organizationId, {
    type: "system.integration-permissions",
    title: copy.title,
    message: copy.message,
    provider: issue.provider,
    scope: issue.scope.kind,
    account: issue.scope.kind === "installation" ? issue.scope.account : issue.scope.name,
    missing: issue.missing.map((m) => m.label),
    features: issue.features,
    fixUrl: issue.fixUrl,
    fixLabel: copy.actionLabel,
  });
}

/** Lifts the deploy-feedback blocks a refused permission set and logs one line. */
async function approved(organizationId: string, resolved: IntegrationIssue[]): Promise<void> {
  if (!resolved.some((i) => i.provider === "github")) return;
  await db
    .update(apps)
    .set({ githubFeedbackBlockedAt: null, githubFeedbackError: null })
    .where(and(eq(apps.organizationId, organizationId), isNotNull(apps.githubFeedbackBlockedAt)));
  const { recordActivity } = await import("@/lib/activity");
  await recordActivity({
    organizationId,
    action: "github_installation.permissions_approved",
    metadata: { keys: resolved.map((i) => i.key) },
  }).catch(() => {});
}

/** The GitHub findings, or null when the App isn't set up. */
async function checkGitHub(): Promise<RaisedIssue[] | null> {
  const { getGitHubAppConfig } = await import("@/lib/system-settings");
  const config = await getGitHubAppConfig();
  if (!config?.appId || !config.privateKey) return null;

  const { createAppAuth } = await import("@octokit/auth-app");
  const { checkGitHubPermissions } = await import("@/lib/git-integration/permission-check");
  const { adminOrgIds } = await import("@/lib/notifications/admin-orgs");
  const { githubInstallationOrgs } = await import("@/lib/db/schema");

  return checkGitHubPermissions({
    appToken: async () => (await createAppAuth({ appId: config.appId, privateKey: config.privateKey })({ type: "app" })).token,
    adminOrgIds,
    installations: async () => {
      const links = await db
        .select({ installationId: githubInstallationOrgs.installationId, organizationId: githubInstallationOrgs.organizationId })
        .from(githubInstallationOrgs);
      const byId = new Map<number, string[]>();
      for (const l of links) byId.set(l.installationId, [...(byId.get(l.installationId) ?? []), l.organizationId]);
      return [...byId].map(([installationId, organizationIds]) => ({ installationId, organizationIds }));
    },
  });
}

let inFlight: Promise<SyncResult> | null = null;

/** One check across providers. Concurrent callers share the run. */
export function runIntegrationCheck(): Promise<SyncResult> {
  if (inFlight) return inFlight;
  rechecker.ran();
  inFlight = (async () => {
    const { isFeatureEnabledAsync } = await import("@/lib/config/features");
    const enabled = await isFeatureEnabledAsync("git-integration");
    const raised = enabled ? await checkGitHub() : null;
    // Not set up or switched off: stale issues clear without claiming an approval.
    const result = await syncIssues("github", raised ?? [], { store: dbIssueStore, notify, approved }, { quiet: raised === null });
    if (result.opened.length || result.resolved.length) {
      log.info(`integration permissions: ${result.opened.length} opened, ${result.resolved.length} resolved`);
    }
    return result;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

const rechecker = createRechecker({
  run: () => runIntegrationCheck().catch((err) => log.warn(`permission check failed: ${err instanceof Error ? err.message : err}`)),
  minIntervalMs: RECHECK_MIN_INTERVAL_MS,
  delayMs: RECHECK_DELAY_MS,
});

/** A provider refused a request in a way that looks like a missing permission. */
export function requestIntegrationRecheck(): void {
  rechecker.request();
}

/** Open issues, one per problem, for one org or across all of them. */
export async function listOpenIssues(organizationId?: string): Promise<IntegrationIssue[]> {
  const byKey = new Map<string, IntegrationIssue>();
  for (const row of await dbIssueStore.listOpen()) {
    if (organizationId && row.organizationId !== organizationId) continue;
    if (row.detail?.issue) byKey.set(row.about, row.detail.issue);
  }
  return [...byKey.values()];
}

let timer: NodeJS.Timeout | null = null;

export function startIntegrationCheckScheduler(): void {
  if (timer) return;
  const tick = () => {
    void runIntegrationCheck().catch((err) => log.warn(`permission check failed: ${err instanceof Error ? err.message : err}`));
  };
  const first = setTimeout(tick, STARTUP_DELAY_MS);
  first.unref?.();
  timer = setInterval(tick, DAY_MS);
  timer.unref?.();
}

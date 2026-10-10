// Turns a check's findings into open issues: notify once per problem, clear what's fixed.

import { issueFingerprint, type IntegrationIssue, type IntegrationProvider, type RaisedIssue } from "./issues";

/** The notification_send type that holds open integration issues. */
export const ISSUE_TYPE = "integration.permissions";

export type StoredIssue = { issue: IntegrationIssue; fingerprint: string };

export type OpenIssue = { organizationId: string; about: string; detail: StoredIssue };

export type IssueStore = {
  listOpen: () => Promise<OpenIssue[]>;
  /** Records the issue as open for the org. False when another process already did. */
  open: (organizationId: string, stored: StoredIssue, now: Date) => Promise<boolean>;
  close: (organizationId: string, abouts: string[], now: Date) => Promise<void>;
};

export type SyncDeps = {
  store: IssueStore;
  notify: (organizationId: string, issue: IntegrationIssue) => void | Promise<void>;
  /** Every issue the org had for the provider is fixed. */
  approved: (organizationId: string, resolved: IntegrationIssue[]) => Promise<void>;
  now?: () => Date;
};

export type SyncResult = { opened: OpenIssue[]; resolved: OpenIssue[] };

const slot = (orgId: string, about: string) => `${orgId}\u0000${about}`;

/** Applies one provider's findings. Issues of other providers are left alone; `quiet` clears without the approval line. */
export async function syncIssues(
  provider: IntegrationProvider,
  raised: RaisedIssue[],
  deps: SyncDeps,
  opts: { quiet?: boolean } = {},
): Promise<SyncResult> {
  const now = deps.now?.() ?? new Date();
  const open = (await deps.store.listOpen()).filter((o) => o.detail?.issue?.provider === provider);
  const openBySlot = new Map(open.map((o) => [slot(o.organizationId, o.about), o]));

  const current = new Map<string, OpenIssue>();
  for (const { issue, organizationIds } of raised) {
    const detail = { issue, fingerprint: issueFingerprint(issue) };
    for (const organizationId of new Set(organizationIds)) {
      current.set(slot(organizationId, issue.key), { organizationId, about: issue.key, detail });
    }
  }

  const opened: OpenIssue[] = [];
  for (const [key, next] of current) {
    if (openBySlot.get(key)?.detail.fingerprint === next.detail.fingerprint) continue;
    if (!(await deps.store.open(next.organizationId, next.detail, now))) continue;
    opened.push(next);
    await deps.notify(next.organizationId, next.detail.issue);
  }

  const resolved = open.filter((o) => !current.has(slot(o.organizationId, o.about)));
  const byOrg = new Map<string, OpenIssue[]>();
  for (const r of resolved) byOrg.set(r.organizationId, [...(byOrg.get(r.organizationId) ?? []), r]);
  for (const [organizationId, rows] of byOrg) {
    await deps.store.close(organizationId, rows.map((r) => r.about), now);
    const stillOpen = [...current.values()].some((c) => c.organizationId === organizationId);
    if (!stillOpen && !opts.quiet) await deps.approved(organizationId, rows.map((r) => r.detail.issue));
  }

  return { opened, resolved };
}

/** Runs `run` soon after a request, at most once per `minIntervalMs`; requests in between fold into one. */
export function createRechecker(opts: {
  run: () => Promise<unknown>;
  minIntervalMs: number;
  delayMs: number;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  let lastAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    request(): boolean {
      if (timer) return false;
      const wait = Math.max(opts.delayMs, lastAt + opts.minIntervalMs - now());
      timer = setTimeout(() => {
        timer = null;
        lastAt = now();
        void opts.run().catch(() => {});
      }, wait);
      timer.unref?.();
      return true;
    },
    /** Records a run that happened another way, such as the daily pass. */
    ran() {
      lastAt = now();
    },
  };
}

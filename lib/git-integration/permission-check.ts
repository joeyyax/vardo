// Reads the App's and each installation's permissions from GitHub and reports what's missing.

import type { RaisedIssue } from "@/lib/integrations/issues";
import {
  appIssue,
  awaitingApproval,
  installationIssue,
  missingFromApp,
  type GitHubAccount,
  type GrantedPermissions,
} from "./required-permissions";

const API = "https://api.github.com";
const TIMEOUT_MS = 10_000;

export type LinkedInstallation = { installationId: number; organizationIds: string[] };

export type PermissionCheckDeps = {
  /** A JWT signed with the App's private key. */
  appToken: () => Promise<string>;
  installations: () => Promise<LinkedInstallation[]>;
  /** Orgs that hear about problems only the App's owner can fix. */
  adminOrgIds: () => Promise<string[]>;
  fetch?: typeof fetch;
};

type AppResponse = { slug: string; owner: GitHubAccount | null; permissions?: GrantedPermissions };
type InstallationResponse = {
  id: number;
  account: GitHubAccount | null;
  permissions?: GrantedPermissions;
  suspended_at?: string | null;
};

async function getJson<T>(fetchImpl: typeof fetch, token: string, path: string): Promise<T | null> {
  const res = await fetchImpl(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** Every permission problem across the App and its linked installations. Throws when GitHub can't be read, so nothing clears on a failed check. */
export async function checkGitHubPermissions(deps: PermissionCheckDeps): Promise<RaisedIssue[]> {
  const fetchImpl = deps.fetch ?? fetch;
  const token = await deps.appToken();
  const app = await getJson<AppResponse>(fetchImpl, token, "/app");
  if (!app) throw new Error("GitHub doesn't recognize the configured App");
  const appPermissions = app.permissions ?? {};
  const raised: RaisedIssue[] = [];

  const owner = app.owner ?? { login: "", type: "User" };
  const fromApp = appIssue(app.slug, owner, missingFromApp(appPermissions));
  if (fromApp) raised.push({ issue: fromApp, organizationIds: await deps.adminOrgIds() });

  for (const linked of await deps.installations()) {
    if (linked.organizationIds.length === 0) continue;
    const inst = await getJson<InstallationResponse>(fetchImpl, token, `/app/installations/${linked.installationId}`);
    if (!inst || inst.suspended_at || !inst.account) continue;
    const issue = installationIssue(inst.id, inst.account, awaitingApproval(appPermissions, inst.permissions ?? {}));
    if (issue) raised.push({ issue, organizationIds: linked.organizationIds });
  }
  return raised;
}

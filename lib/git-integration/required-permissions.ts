// The GitHub App permissions Vardo needs, which feature needs each and where to fix a gap.

import type { IntegrationIssue, MissingCapability } from "@/lib/integrations/issues";

export type GitHubFeature = "deploy" | "pr-comments" | "deployments" | "commit-status";

export const GITHUB_FEATURES: Record<GitHubFeature, string> = {
  deploy: "Deploying from GitHub",
  "pr-comments": "Deploy comments on pull requests",
  deployments: "Deployments on GitHub",
  "commit-status": "Commit status checks",
};

export type Access = "read" | "write";

export type RequiredPermission = {
  /** The key GitHub uses in a permissions object. */
  id: string;
  label: string;
  access: Access;
  /** What it lets Vardo do, read after "so it can". */
  purpose: string;
  features: GitHubFeature[];
};

export const GITHUB_REQUIRED_PERMISSIONS: RequiredPermission[] = [
  { id: "metadata", label: "Metadata", access: "read", purpose: "see your repositories", features: ["deploy"] },
  { id: "contents", label: "Contents", access: "read", purpose: "clone your code to deploy it", features: ["deploy"] },
  { id: "pull_requests", label: "Pull requests", access: "write", purpose: "comment on pull requests", features: ["pr-comments"] },
  { id: "deployments", label: "Deployments", access: "write", purpose: "show deploy progress on pull requests", features: ["deployments"] },
  { id: "statuses", label: "Commit statuses", access: "write", purpose: "show deploy progress on pull requests", features: ["commit-status"] },
];

export type GrantedPermissions = Record<string, string | undefined>;

const RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether a granted level covers the required one. */
export function covers(granted: string | undefined, required: Access): boolean {
  return (RANK[granted ?? ""] ?? 0) >= RANK[required];
}

/** Permissions the App itself doesn't ask for. Only the App's owner can add them. */
export function missingFromApp(app: GrantedPermissions, required = GITHUB_REQUIRED_PERMISSIONS): RequiredPermission[] {
  return required.filter((p) => !covers(app[p.id], p.access));
}

/** Permissions the App asks for that the installation hasn't accepted yet. */
export function awaitingApproval(
  app: GrantedPermissions,
  installation: GrantedPermissions,
  required = GITHUB_REQUIRED_PERMISSIONS,
): RequiredPermission[] {
  return required.filter((p) => covers(app[p.id], p.access) && !covers(installation[p.id], p.access));
}

export type GitHubAccount = { login: string; type: string };

const enc = encodeURIComponent;

/** The App's permissions page, under the owner's personal or organization settings. */
export function appPermissionsUrl(slug: string, owner: GitHubAccount): string {
  return owner.type === "Organization"
    ? `https://github.com/organizations/${enc(owner.login)}/settings/apps/${enc(slug)}/permissions`
    : `https://github.com/settings/apps/${enc(slug)}/permissions`;
}

/** The installation page where the account accepts new permissions. */
export function installationUrl(installationId: number, account: GitHubAccount): string {
  return account.type === "Organization"
    ? `https://github.com/organizations/${enc(account.login)}/settings/installations/${installationId}`
    : `https://github.com/settings/installations/${installationId}`;
}

function toIssueFields(missing: RequiredPermission[]): Pick<IntegrationIssue, "missing" | "features" | "purposes"> {
  const caps: MissingCapability[] = missing.map((p) => ({ id: p.id, label: p.label, access: p.access }));
  const features = [...new Set(missing.flatMap((p) => p.features))].map((f) => GITHUB_FEATURES[f]);
  const purposes = [...new Set(missing.map((p) => p.purpose))];
  return { missing: caps, features, purposes };
}

export function appIssue(slug: string, owner: GitHubAccount, missing: RequiredPermission[]): IntegrationIssue | null {
  if (missing.length === 0) return null;
  return {
    key: "github:app",
    provider: "github",
    scope: { kind: "app", name: slug },
    fixUrl: appPermissionsUrl(slug, owner),
    ...toIssueFields(missing),
  };
}

export function installationIssue(installationId: number, account: GitHubAccount, missing: RequiredPermission[]): IntegrationIssue | null {
  if (missing.length === 0) return null;
  return {
    key: `github:installation:${installationId}`,
    provider: "github",
    scope: { kind: "installation", id: String(installationId), account: account.login },
    fixUrl: installationUrl(installationId, account),
    ...toIssueFields(missing),
  };
}

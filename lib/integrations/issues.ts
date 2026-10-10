// Provider-neutral shape for an integration that lacks a permission Vardo needs.

export type IntegrationProvider = "github" | "gitlab" | "gitea";

export const PROVIDER_NAME: Record<IntegrationProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
};

/** Who must act: the owner of the app registration, or the account that installed it. */
export type IssueScope =
  | { kind: "app"; name: string }
  | { kind: "installation"; id: string; account: string };

export type MissingCapability = {
  id: string;
  label: string;
  access: "read" | "write";
};

export type IntegrationIssue = {
  /** Stable per problem, e.g. github:app or github:installation:42. */
  key: string;
  provider: IntegrationProvider;
  scope: IssueScope;
  missing: MissingCapability[];
  /** The provider page that fixes it. */
  fixUrl: string;
  /** Plain names of what stays off until it's fixed. */
  features: string[];
  /** What the missing capabilities let Vardo do, as verb phrases. */
  purposes: string[];
};

/** An issue and the orgs that should hear about it. */
export type RaisedIssue = { issue: IntegrationIssue; organizationIds: string[] };

/** Changes when the problem itself changes, so a notification goes out again. */
export function issueFingerprint(issue: IntegrationIssue): string {
  const missing = issue.missing.map((m) => `${m.id}:${m.access}`).sort().join(",");
  return `${issue.key}|${missing}|${issue.fixUrl}`;
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export type IssueCopy = { title: string; message: string; degraded: string; actionLabel: string };

/** The words every surface uses for an issue: attention item, settings page and notification. */
export function issueCopy(issue: IntegrationIssue): IssueCopy {
  const provider = PROVIDER_NAME[issue.provider];
  const names = joinList(issue.missing.map((m) => m.label));
  const why = issue.purposes.length ? ` so it can ${joinList(issue.purposes)}` : "";
  const degraded = issue.features.length ? `Off until then: ${joinList(issue.features.map(lower))}.` : "";
  if (issue.scope.kind === "app") {
    return {
      title: `${provider} App needs more permissions`,
      message: `Vardo's ${provider} App doesn't ask for ${names} yet. Add ${issue.missing.length === 1 ? "it" : "them"} on the App's permissions page${why}, then accept the change on each installation.`,
      degraded,
      actionLabel: "Open App permissions",
    };
  }
  return {
    title: `${provider} needs one more approval`,
    message: `Vardo's ${provider} App now asks for ${names}${why}. Review and accept the new permissions for ${issue.scope.account}.`,
    degraded,
    actionLabel: "Review and accept",
  };
}

function lower(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

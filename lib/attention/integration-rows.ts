// The attention row for integrations missing a permission: one routine item per problem.

import { issueCopy, type IntegrationIssue } from "@/lib/integrations/issues";
import type { AttentionRow } from "@/lib/ui/attention";

export const INTEGRATION_SETTINGS_HREF = "/admin/settings/github";

export function integrationRows(
  issues: { issue: IntegrationIssue; since: string }[],
  opts: { orgId: string; isAppAdmin: boolean },
): AttentionRow[] {
  // Only the App's owner can fix an App-level gap, so only admins see it.
  const visible = issues.filter(({ issue }) => issue.scope.kind !== "app" || opts.isAppAdmin);
  if (visible.length === 0) return [];
  return [
    {
      key: "integration-permissions",
      label: "Integrations",
      tone: "warning",
      footer: "Vardo checks again daily and whenever the provider refuses a request.",
      action: { label: "Check again", post: `/api/v1/organizations/${opts.orgId}/integrations/check` },
      items: visible.map(({ issue, since }) => {
        const copy = issueCopy(issue);
        return {
          id: `integration:${issue.key}`,
          name: copy.title,
          detail: [copy.message, copy.degraded].filter(Boolean).join(" "),
          since,
          where: issue.scope.kind === "installation" ? issue.scope.account : undefined,
          href: opts.isAppAdmin ? INTEGRATION_SETTINGS_HREF : undefined,
          fix: { label: copy.actionLabel, href: issue.fixUrl, external: true },
          secondary: { label: "Check again", post: `/api/v1/organizations/${opts.orgId}/integrations/check` },
          urgent: false,
        };
      }),
    },
  ];
}

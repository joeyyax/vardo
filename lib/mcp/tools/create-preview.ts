import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/lib/db";
import { apps } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { createPreview } from "@/lib/docker/preview";
import type { McpAuthContext } from "../auth";

export function registerCreatePreview(
  server: McpServer,
  context: McpAuthContext
) {
  server.tool(
    "vardo_create_preview",
    "Create a preview environment for a GitHub pull request. Deploys the PR branch as an isolated environment and returns the preview URLs. Returns the group environment ID needed for other preview tools.",
    {
      repo: z
        .string()
        .describe("GitHub repository in owner/repo format (e.g. 'acme/myapp')"),
      branch: z
        .string()
        .describe("Branch name to deploy (e.g. 'feat/my-feature')"),
      pr_number: z
        .number()
        .int()
        .min(1)
        .describe("Pull request number"),
      pr_url: z
        .string()
        .optional()
        .describe("Full URL of the pull request (optional)"),
      ttl_days: z
        .number()
        .int()
        .min(1)
        .max(30)
        .default(7)
        .describe("Days before auto-cleanup (default 7)"),
    },
    async ({ repo, branch, pr_number, pr_url, ttl_days }) => {
      // Verify this org has an app tracking the given repo
      const gitUrl = `https://github.com/${repo}.git`;

      const orgApp = await db.query.apps.findFirst({
        where: and(
          eq(apps.gitUrl, gitUrl),
          eq(apps.organizationId, context.organizationId)
        ),
        columns: { id: true },
      });

      if (!orgApp) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `No app found for repo ${repo} in this organization`,
              }),
            },
          ],
          isError: true,
        };
      }

      const result = await createPreview({
        repoFullName: repo,
        prNumber: pr_number,
        prUrl: pr_url ?? `https://github.com/${repo}/pull/${pr_number}`,
        branch,
        ttlDays: ttl_days,
      });

      if (!result) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error:
                  "Could not create preview — app must be part of a project and have a matching branch configured",
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                previewId: result.groupEnvironmentId,
                domains: result.domains,
                deployed: result.deployed,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

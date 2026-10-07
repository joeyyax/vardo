import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { adoptCompose, adoptFields, adoptSchema } from "@/lib/docker/adopt";
import type { McpAuthContext } from "../auth";
import { accessDenied, resolveProjectOrg, resolveTargetOrg } from "../scope";

// Matches the REST adopt route's "mutation" tier: 60 per minute.
const ADOPT_RATE_LIMIT = 60;
const ADOPT_RATE_WINDOW_MS = 60 * 1000;

function fail(error: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
    isError: true as const,
  };
}

export function registerAdoptApp(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_adopt_app",
    "Adopt an existing Docker Compose project into Vardo. Send the CONTENTS of docker-compose.yml as composeContent (not a file path; the server never reads its own filesystem). Optionally send the parsed vardo.yml as projectConfig. Any member of the organization can adopt.",
    {
      composeContent: adoptFields.composeContent.describe(
        "The full text of docker-compose.yml. Required. Not a path."
      ),
      projectConfig: adoptFields.projectConfig.describe(
        "Parsed vardo.yml as an object, e.g. { environments: { local: { domain, exclude: [service] } } }"
      ),
      name: adoptFields.name.describe("App slug (lowercase letters, digits, hyphens)"),
      displayName: adoptFields.displayName.describe("Human-readable app name"),
      environmentType: adoptFields.environmentType.describe("Environment type to create (default: local)"),
      projectId: adoptFields.projectId.describe("Existing project ID to link to"),
      newProjectName: adoptFields.newProjectName.describe("Create a new project with this name"),
      organizationId: z
        .string()
        .optional()
        .describe(
          "Organization to adopt into when creating a new project (default: the token's own organization). Ignored when projectId is given — the project's own organization wins."
        ),
      domain: adoptFields.domain.describe("Custom domain (default: <name>.localhost)"),
      containerPort: adoptFields.containerPort.describe("Primary container port (default: 3000)"),
    },
    async ({ organizationId, ...fields }) => {
      const parsed = adoptSchema.safeParse(fields);
      if (!parsed.success) return fail(parsed.error.issues[0].message);
      const data = parsed.data;

      // An existing project pins the org; otherwise the requested org after a membership check.
      const orgId = data.projectId
        ? await resolveProjectOrg(context, data.projectId, "app.create")
        : await resolveTargetOrg(context, organizationId, "app.create");
      if (!orgId) return accessDenied("Project");

      if (!(await isFeatureEnabledAsync("container-import"))) {
        return fail('Feature "container-import" is not enabled.');
      }

      const rl = await slidingWindowRateLimit(
        `${context.userId}:${orgId}`,
        "mcp:adopt-app",
        ADOPT_RATE_LIMIT,
        ADOPT_RATE_WINDOW_MS
      );
      if (rl.limited) return fail(`Rate limit exceeded. Try again in ${rl.retryAfterSeconds}s.`);

      try {
        const result = await adoptCompose(data, { orgId, userId: context.userId, source: "mcp" });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.body, null, 2) }],
          ...(result.ok ? {} : { isError: true as const }),
        };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { slidingWindowRateLimit } from "@/lib/api/rate-limit";
import { buildSecretName, buildSecretValue, deleteBuildSecret, listBuildSecrets, setBuildSecret } from "@/lib/build-secrets/store";
import type { McpAuthContext } from "../auth";
import { accessDenied, resolveTargetOrg } from "../scope";
import { failure, iso, text } from "./result";

// 10 build secret writes per 5 minutes per user/org pair.
const WRITE_LIMIT = 10;
const WRITE_WINDOW_MS = 5 * 60 * 1000;

const orgArg = z.string().optional().describe("Defaults to the token's org");

export function registerBuildSecretTools(server: McpServer, context: McpAuthContext) {
  server.tool(
    "vardo_list_build_secrets",
    "List the org's build secrets by name. Values are write-only and never returned.",
    { organizationId: orgArg },
    async ({ organizationId }) => {
      const orgId = await resolveTargetOrg(context, organizationId, "org.buildSecrets.manage");
      if (!orgId) return accessDenied("Organization");
      const rows = await listBuildSecrets(orgId);
      return text({ buildSecrets: rows.map((r) => ({ name: r.name, updatedAt: iso(r.updatedAt) })) });
    },
  );

  server.tool(
    "vardo_set_build_secret",
    "Set or delete an org build secret. Dockerfiles mount it with RUN --mount=type=secret,id=<name>. An org secret named npm_token replaces the GitHub App token. Takes effect on the next deploy. Omit value to delete.",
    {
      organizationId: orgArg,
      name: buildSecretName.describe("Secret id: lowercase letters, digits and underscores, starting with a letter"),
      value: buildSecretValue.optional().describe("The secret; omit to delete it"),
    },
    async ({ organizationId, name, value }) => {
      const orgId = await resolveTargetOrg(context, organizationId, "org.buildSecrets.manage");
      if (!orgId) return accessDenied("Organization");
      const rl = await slidingWindowRateLimit(`${context.userId}:${orgId}`, "mcp:set-build-secret", WRITE_LIMIT, WRITE_WINDOW_MS);
      if (rl.limited) return failure(`Rate limit exceeded. Try again in ${rl.retryAfterSeconds}s.`);

      if (value === undefined) {
        if (!(await deleteBuildSecret(orgId, name, context.userId, "mcp"))) return failure(`No build secret named ${name}`);
        return text({ deleted: name });
      }
      const saved = await setBuildSecret(orgId, name, value, context.userId, "mcp");
      return text({ saved: saved.name, updatedAt: iso(saved.updatedAt) });
    },
  );
}

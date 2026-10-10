import type { Capability } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/app-services/actor";
import { ServiceError } from "@/lib/app-services/errors";
import { mcpActor } from "@/lib/app-services/mcp-actor";
import type { McpAuthContext } from "./auth";
import { accessDenied, accessibleOrgIds } from "./scope";

/** An actor for every organization the token may act on with `cap`. */
export async function accessibleActors(context: McpAuthContext, cap: Capability): Promise<Actor[]> {
  const orgIds = await accessibleOrgIds(context, cap);
  const actors = await Promise.all(orgIds.map((orgId) => mcpActor(context, orgId, cap)));
  return actors.filter((a): a is Actor => a !== null);
}

/** A tool result for a service refusal. A denial and a miss read the same, so neither confirms the other exists. */
export function serviceErrorResult(error: unknown, resource: string) {
  if (!(error instanceof ServiceError)) throw error;
  if (error.status === 403 || error.status === 404) return accessDenied(resource);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: error.message }) }],
    isError: true as const,
  };
}

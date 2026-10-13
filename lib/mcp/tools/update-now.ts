import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { UpdateBlockedError } from "@/lib/self-update/runner";
import { updateNow } from "@/lib/self-update/update-now";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";
import { failure, text } from "./result";

/** Registered only for a token with the admin scope. */
export function registerUpdateNow(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_update_now",
    "Update this Vardo instance now, as the Maintenance page's Update now does: dumps the database, redeploys on the update channel and verifies. Returns the deployment ID. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);

      try {
        return text(await updateNow(context.userId));
      } catch (err) {
        if (err instanceof UpdateBlockedError) return failure(err.message);
        throw err;
      }
    },
  );
}

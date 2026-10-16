import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ADMIN_FORBIDDEN_MESSAGE } from "@/lib/auth/admin-error";
import { effectiveChannel, updatePolicySchema, type UpdatePolicy } from "@/lib/self-update/policy";
import { saveUpdatePolicy } from "@/lib/self-update/save-policy";
import { getUpdatePolicy } from "@/lib/self-update/store";
import type { McpAuthContext } from "../auth";
import { canAdminInstance } from "../scope";
import { failure, text } from "./result";

const input = updatePolicySchema.partial().shape;

const present = (policy: UpdatePolicy) => ({ ...policy, effectiveChannel: effectiveChannel(policy) });

/** Update policy tools. Registered only for a token with the admin scope. */
export function registerUpdatePolicyTools(server: McpServer, context: McpAuthContext) {
  if (!context.adminScope) return;

  server.tool(
    "vardo_get_update_policy",
    "Read this instance's update policy: mode, rollout priority, channel (null follows the mode's default) and the channel in effect. Needs a token with the admin scope.",
    {},
    async () => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);
      return text(present(await getUpdatePolicy()));
    },
  );

  server.tool(
    "vardo_set_update_policy",
    "Change this instance's update mode, rollout priority or channel; omitted fields keep their values. Takes effect on the instance's next update check. Needs a token with the admin scope.",
    {
      mode: input.mode.describe("off, notify or auto"),
      priority: input.priority.describe("Rollout order across linked instances: critical, standard or low"),
      channel: input.channel.describe("main or releases; null follows the mode's default"),
    },
    async (args) => {
      if (!(await canAdminInstance(context))) return failure(ADMIN_FORBIDDEN_MESSAGE);
      const given = Object.fromEntries(Object.entries(args).filter(([key, value]) => key in input && value !== undefined));
      if (Object.keys(given).length === 0) return failure("Pass mode, priority or channel");

      const parsed = updatePolicySchema.safeParse({ ...(await getUpdatePolicy()), ...given });
      if (!parsed.success) return failure(parsed.error.issues[0]?.message ?? "Invalid update policy");
      return text(present(await saveUpdatePolicy(parsed.data, context.userId)));
    },
  );
}

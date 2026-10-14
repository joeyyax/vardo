import { recordActivity } from "@/lib/activity";
import { adminOrgIds } from "@/lib/notifications/admin-orgs";
import type { UpdatePolicy } from "./policy";
import { getUpdatePolicy, setUpdatePolicy } from "./store";

/** Saves the update policy and logs a change in every admin org. Returns the saved policy. */
export async function saveUpdatePolicy(next: UpdatePolicy, userId: string): Promise<UpdatePolicy> {
  const previous = await getUpdatePolicy();
  await setUpdatePolicy(next);
  if (previous.mode !== next.mode || previous.priority !== next.priority || previous.channel !== next.channel) {
    for (const organizationId of await adminOrgIds()) {
      await recordActivity({
        organizationId, userId, action: "system.update_policy_changed",
        metadata: { mode: next.mode, priority: next.priority, channel: next.channel },
      });
    }
  }
  return getUpdatePolicy();
}

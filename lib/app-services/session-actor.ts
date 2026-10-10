import { cache } from "react";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { isAppAdmin } from "@/lib/auth/admin";
import type { Actor } from "./actor";

/** The signed-in caller in their current org, or null without a session or org. */
export const currentActor = cache(async (): Promise<Actor | null> => {
  const [session, orgData] = await Promise.all([getSession(), getCurrentOrg()]);
  if (!session?.user?.id || !orgData) return null;
  return {
    userId: session.user.id,
    org: orgData.organization,
    membership: orgData.membership,
    instanceAdmin: await isAppAdmin(),
  };
});

/** The caller as an actor in `orgId`, or null when that isn't their current org. Throws like requireOrg without a session or org. */
export async function actorForOrg(orgId: string): Promise<Actor | null> {
  const session = await getSession();
  if (!session?.user?.id) throw new Error("Unauthorized");
  const actor = await currentActor();
  if (!actor) throw new Error("No organization found");
  return actor.org.id === orgId ? actor : null;
}

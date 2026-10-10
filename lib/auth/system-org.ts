// The system org is trusted and reaches docker.sock, so its members are exactly the instance admins.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, user } from "@/lib/db/schema";

export {
  SYSTEM_ORG_MEMBERS_ONLY_ADMINS,
  SYSTEM_ORG_NO_INVITES,
  SYSTEM_EXEC_REQUIRES_ADMIN,
} from "./system-org-messages";

/** True when the user row is flagged instance admin. Credential-independent. */
export async function isInstanceAdminUser(userId: string): Promise<boolean> {
  const row = await db.query.user.findFirst({
    where: eq(user.id, userId),
    columns: { isAppAdmin: true },
  });
  return Boolean(row?.isAppAdmin);
}

/** True when the org is the built-in system org. */
export async function isSystemOrg(orgId: string): Promise<boolean> {
  const org = await db.query.organizations.findFirst({
    where: eq(organizations.id, orgId),
    columns: { isSystemManaged: true },
  });
  return Boolean(org?.isSystemManaged);
}

/** Whether `userId` may hold a membership in `orgId`. */
export async function mayBeMember(orgId: string, userId: string): Promise<boolean> {
  if (!(await isSystemOrg(orgId))) return true;
  return isInstanceAdminUser(userId);
}

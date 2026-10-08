import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, user } from "@/lib/db/schema";
import { needsSetup } from "@/lib/setup";
import { getAuthConfig } from "@/lib/system-settings";
import { hasSetupToken } from "@/lib/setup-token";

export const REGISTRATION_CLOSED_MESSAGE = "Registration is closed on this instance. Ask an admin for an invitation.";

async function hasPendingInvitation(email: string): Promise<boolean> {
  const row = await db.query.invitations.findFirst({
    where: and(
      sql`lower(${invitations.email}) = ${email.trim().toLowerCase()}`,
      eq(invitations.status, "pending"),
      gt(invitations.expiresAt, new Date()),
    ),
    columns: { id: true },
  });
  return row !== undefined;
}

export const SETUP_TOKEN_MESSAGE = "Enter the setup token on the setup page before creating the first account.";

/** Whether the sign-up request may create the first account: the setup token is present, or setup is already closed. */
export async function setupTokenAllowsSignup(): Promise<boolean> {
  if (!(await needsSetup())) return true;
  try {
    const { headers } = await import("next/headers");
    return hasSetupToken(await headers());
  } catch {
    // Outside a request there's no token to read.
    return false;
  }
}

/** Whether a new account may be created for this email. "approval" refuses like "closed". */
export async function registrationAllowed(email: string): Promise<boolean> {
  if (await needsSetup()) return true;
  const { registrationMode } = await getAuthConfig();
  if (registrationMode === "open") return true;
  return hasPendingInvitation(email);
}

/** The first account and open-registration signups get an org of their own; invitees join theirs. */
export async function shouldCreateDefaultOrg(): Promise<boolean> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(user);
  if (Number(row?.count) <= 1) return true;
  const { registrationMode } = await getAuthConfig();
  return registrationMode === "open";
}

// The signed-in browser user that instance sign-in and browse act for.

import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/error-response";
import { getSession } from "@/lib/auth/session";

export type InstanceUser = { id: string; email: string; emailVerified: boolean; twoFactorEnabled: boolean | null };

/** The session user, or the response refusing the request. API tokens can't act on other instances. */
export async function instanceUser(): Promise<{ user: InstanceUser } | { response: NextResponse }> {
  const session = await getSession();
  if (!session?.user?.id) return { response: apiError.unauthorized() };
  if (session.authMethod !== "session") {
    return { response: NextResponse.json({ error: "Only a signed-in browser session can reach other instances" }, { status: 403 }) };
  }
  const u = session.user as typeof session.user & { twoFactorEnabled?: boolean | null };
  return { user: { id: u.id, email: u.email, emailVerified: u.emailVerified, twoFactorEnabled: u.twoFactorEnabled ?? null } };
}


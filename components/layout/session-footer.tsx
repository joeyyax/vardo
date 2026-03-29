import Link from "next/link";
import { db } from "@/lib/db";
import { session as sessionTable } from "@/lib/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { getSession, getCurrentOrg } from "@/lib/auth/session";

function formatSessionTime(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  }) + " at " + date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

export async function SessionFooter() {
  const [session, orgData] = await Promise.all([
    getSession(),
    getCurrentOrg(),
  ]);

  if (!session?.user?.id || !orgData) return null;

  const { user } = session;
  const { organization, membership } = orgData;

  // Count active sessions for this user (not expired)
  const activeSessions = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(
      and(
        eq(sessionTable.userId, user.id),
        gt(sessionTable.expiresAt, new Date())
      )
    );

  const sessionCount = activeSessions.length;
  const createdAt = session.session?.createdAt
    ? new Date(session.session.createdAt)
    : null;
  const expiresAt = session.session?.expiresAt
    ? new Date(session.session.expiresAt)
    : null;

  return (
    <footer className="px-5 py-2 text-[11px] text-muted-foreground/60 leading-relaxed">
      <div className="flex flex-wrap justify-center gap-x-1">
        <span>
          Signed in as{" "}
          <Link href="/user/settings/profile" className="text-muted-foreground hover:text-foreground transition-colors">
            {user.name}
          </Link>{" "}
          ({user.email}),
        </span>
        <span>
          <Link href="/settings/team" className="text-muted-foreground hover:text-foreground transition-colors">
            {membership.role}
          </Link>{" "}
          in{" "}
          <Link href="/settings/general" className="text-muted-foreground hover:text-foreground transition-colors">
            {organization.name}
          </Link>.
        </span>
        {"isAppAdmin" in user && (user as { isAppAdmin?: boolean }).isAppAdmin && (
          <Link href="/admin/settings/general" className="hover:text-foreground transition-colors">
            System admin.
          </Link>
        )}
        {createdAt && expiresAt && (
          <span>
            Session started {formatSessionTime(createdAt)}, expires{" "}
            {formatSessionTime(expiresAt)}.
          </span>
        )}
        {sessionCount > 1 && (
          <span>
            Signed in from {sessionCount} locations.
          </span>
        )}
        <span>
          Vardo {process.env.npm_package_version || "0.1.0"}
          {process.env.NEXT_PUBLIC_GIT_SHA && (
            <> ({process.env.NEXT_PUBLIC_GIT_SHA.slice(0, 7)})</>
          )}
        </span>
      </div>
    </footer>
  );
}

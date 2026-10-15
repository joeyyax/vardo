import Link from "next/link";
import { getSession } from "@/lib/auth/session";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { currentActor } from "@/lib/app-services/session-actor";
import { activeSessionCount } from "@/lib/app-services/viewer";
import { RelativeTime } from "@/components/relative-time";
import { versionLabel } from "@/lib/app-services/system-status";

export async function SessionFooter() {
  const [session, actor, teamsEnabled] = await Promise.all([
    getSession(),
    currentActor(),
    isFeatureEnabledAsync("teams"),
  ]);

  if (!session?.user?.id || !actor) return null;

  const { user } = session;
  const { org: organization, membership } = actor;

  const sessionCount = await activeSessionCount(actor);
  const createdAt = session.session?.createdAt
    ? new Date(session.session.createdAt)
    : null;
  const expiresAt = session.session?.expiresAt
    ? new Date(session.session.expiresAt)
    : null;

  return (
    <footer className="px-5 py-2 text-xs text-muted-foreground leading-relaxed">
      <div className="flex flex-wrap justify-center gap-x-1">
        <span>
          Signed in as{" "}
          <Link href="/user/settings/profile" className="text-muted-foreground hover:text-foreground transition-colors">
            {user.name}
          </Link>{" "}
          ({user.email}),
        </span>
        <span>
          {teamsEnabled ? (
            <Link href="/settings/team" className="text-muted-foreground hover:text-foreground transition-colors">
              {membership.role}
            </Link>
          ) : (
            membership.role
          )}{" "}
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
            Session started <RelativeTime date={createdAt} absoluteFirst />, expires{" "}
            <RelativeTime date={expiresAt} absoluteFirst />.
          </span>
        )}
        {sessionCount > 1 && (
          <span>
            Signed in from {sessionCount} locations.
          </span>
        )}
        <span>
          {versionLabel()}
        </span>
      </div>
    </footer>
  );
}

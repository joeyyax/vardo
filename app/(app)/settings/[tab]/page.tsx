import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { memberships, invitations } from "@/lib/db/schema";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { OrgEnvVarsEditor } from "../org-env-vars";
import { OrgDomainEditor } from "../org-domain-editor";
import { NotificationChannelsEditor } from "../notification-channels";
import { DigestSettingsEditor } from "../digest-settings";
import { TeamMembers } from "@/app/(app)/team/team-members";
import { InvitationsPanel } from "../invitations";

const VALID_TABS = ["variables", "domains", "notifications", "team", "invitations"] as const;
type ValidTab = (typeof VALID_TABS)[number];

export default async function OrgSettingsTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  if (!VALID_TABS.includes(tab as ValidTab)) {
    notFound();
  }

  const session = await getSession();
  const orgData = await getCurrentOrg();

  if (!orgData || !session?.user?.id) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;

  switch (tab as ValidTab) {
    case "variables":
      return <OrgEnvVarsEditor orgId={orgId} />;

    case "domains":
      return (
        <OrgDomainEditor
          orgId={orgId}
          defaultDomain={process.env.VARDO_BASE_DOMAIN || "joeyyax.dev"}
          sslEnabled={orgData.organization.sslEnabled ?? true}
          serverIP={process.env.VARDO_SERVER_IP}
        />
      );

    case "notifications":
      return (
        <div className="space-y-4">
          <NotificationChannelsEditor orgId={orgId} />
          <DigestSettingsEditor orgId={orgId} />
        </div>
      );

    case "team": {
      const organizations = await getUserOrganizations();

      const orgMemberships = await db.query.memberships.findMany({
        where: eq(memberships.organizationId, orgId),
        with: {
          user: {
            columns: { id: true, name: true, email: true, image: true },
          },
        },
      });

      const members = orgMemberships.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        email: m.user.email,
        image: m.user.image,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
      }));

      return (
        <TeamMembers
          members={members}
          orgId={orgId}
          orgName={orgData.organization.name}
          currentRole={orgData.membership.role}
          currentUserId={session.user.id}
          organizations={organizations}
          embedded
        />
      );
    }

    case "invitations": {
      const orgInvitations = await db.query.invitations.findMany({
        where: and(
          eq(invitations.scope, "org"),
          eq(invitations.targetId, orgId),
        ),
        with: {
          inviter: {
            columns: { id: true, name: true },
          },
        },
        orderBy: (t, { desc }) => [desc(t.createdAt)],
      });

      const invitationList = orgInvitations.map((inv) => ({
        id: inv.id,
        email: inv.email,
        role: inv.role,
        status: inv.status as "pending" | "accepted" | "expired",
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt.toISOString(),
        inviter: inv.inviter
          ? { id: inv.inviter.id, name: inv.inviter.name }
          : null,
      }));

      return (
        <InvitationsPanel
          orgId={orgId}
          orgName={orgData.organization.name}
          currentRole={orgData.membership.role}
          invitations={invitationList}
        />
      );
    }
  }
}

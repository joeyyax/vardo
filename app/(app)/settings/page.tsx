import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { memberships, invitations } from "@/lib/db/schema";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, and } from "drizzle-orm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrgEnvVarsEditor } from "./org-env-vars";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { TeamMembers } from "@/app/(app)/team/team-members";
import { OrgDomainEditor } from "./org-domain-editor";
import { NotificationChannelsEditor } from "./notification-channels";
import { InvitationsPanel } from "./invitations";
import { DigestSettingsEditor } from "./digest-settings";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const session = await getSession();
  const orgData = await getCurrentOrg();

  if (!orgData || !session?.user?.id) {
    redirect("/onboarding");
  }

  const orgId = orgData.organization.id;
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
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <OrgSwitcher
          currentOrgId={orgId}
          organizations={organizations}
          collapsed={false}
        />
      </div>

      <Tabs defaultValue={tab || "variables"}>
        <TabsList variant="line">
          <TabsTrigger value="variables">Shared variables</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="invitations">Invitations</TabsTrigger>
        </TabsList>

        <TabsContent value="variables" className="pt-4">
          <OrgEnvVarsEditor orgId={orgId} />
        </TabsContent>

        <TabsContent value="domains" className="pt-4">
          <OrgDomainEditor
            orgId={orgId}
            defaultDomain={process.env.HOST_BASE_DOMAIN || "joeyyax.dev"}
            sslEnabled={orgData.organization.sslEnabled ?? true}
            serverIP={process.env.HOST_SERVER_IP}
          />
        </TabsContent>

        <TabsContent value="notifications" className="pt-4">
          <div className="space-y-8">
            <NotificationChannelsEditor orgId={orgId} />
            <div className="border-t border-border pt-6">
              <DigestSettingsEditor orgId={orgId} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="team" className="pt-4">
          <TeamMembers
            members={members}
            orgId={orgId}
            orgName={orgData.organization.name}
            currentRole={orgData.membership.role}
            currentUserId={session.user.id}
            organizations={organizations}
            embedded
          />
        </TabsContent>

        <TabsContent value="invitations" className="pt-4">
          <InvitationsPanel
            orgId={orgId}
            orgName={orgData.organization.name}
            currentRole={orgData.membership.role}
            invitations={invitationList}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

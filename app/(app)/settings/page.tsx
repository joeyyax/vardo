import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { memberships, groups, projects } from "@/lib/db/schema";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq, asc } from "drizzle-orm";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrgEnvVarsEditor } from "./org-env-vars";
import { OrgSwitcher } from "@/components/layout/org-switcher";
import { TeamMembers } from "@/app/(app)/team/team-members";
import { GroupManager } from "./group-manager";
import { OrgDomainEditor } from "./org-domain-editor";

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

  const groupList = await db.query.groups.findMany({
    where: eq(groups.organizationId, orgId),
    orderBy: [asc(groups.name)],
    with: {
      projects: {
        columns: { id: true, name: true, displayName: true, status: true },
      },
    },
  });

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
          <TabsTrigger value="variables">Shared Variables</TabsTrigger>
          <TabsTrigger value="domains">Domains</TabsTrigger>
          <TabsTrigger value="groups">Groups</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>

        <TabsContent value="variables" className="pt-4">
          <OrgEnvVarsEditor orgId={orgId} />
        </TabsContent>

        <TabsContent value="domains" className="pt-4">
          <OrgDomainEditor
            orgId={orgId}
            defaultDomain="joeyyax.dev"
            sslEnabled={orgData.organization.sslEnabled ?? true}
          />
        </TabsContent>

        <TabsContent value="groups" className="pt-4">
          <GroupManager
            groups={groupList.map((g) => ({
              id: g.id,
              name: g.name,
              color: g.color,
              projects: g.projects.map((p) => ({
                id: p.id,
                name: p.name,
                displayName: p.displayName,
                status: p.status,
              })),
            }))}
            orgId={orgId}
          />
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
      </Tabs>
    </div>
  );
}

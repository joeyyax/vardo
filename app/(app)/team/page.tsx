import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { memberships } from "@/lib/db/schema";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { eq } from "drizzle-orm";
import { TeamMembers } from "./team-members";

export default async function TeamPage() {
  const session = await getSession();
  const orgData = await getCurrentOrg();

  if (!orgData || !session?.user?.id) {
    redirect("/login");
  }

  const orgId = orgData.organization.id;
  const currentRole = orgData.membership.role;
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
      currentRole={currentRole}
      currentUserId={session.user.id}
      organizations={organizations}
    />
  );
}

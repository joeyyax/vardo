import { redirect } from "next/navigation";
import { getSession, getCurrentOrg } from "@/lib/auth/session";
import { isAdminRole } from "@/lib/auth/permissions";
import { TeamContent } from "./team-content";

export default async function TeamPage() {
  const [session, orgData] = await Promise.all([
    getSession(),
    getCurrentOrg(),
  ]);

  if (!session?.user?.id || !orgData) {
    redirect("/onboarding");
  }

  const { organization, membership } = orgData;
  const isAdmin = isAdminRole(membership.role);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Team</h1>
        <p className="text-sm text-muted-foreground">
          Manage your organization&apos;s team members and invitations.
        </p>
      </div>
      <TeamContent
        orgId={organization.id}
        orgName={organization.name}
        isAdmin={isAdmin}
        currentUserId={session.user.id}
      />
    </div>
  );
}

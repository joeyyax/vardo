import { redirect, notFound } from "next/navigation";
import { getCurrentOrg, getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { clients, projects } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { ClientDashboard } from "./client-dashboard";

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function ClientPage({ params }: PageProps) {
  const [orgData, session] = await Promise.all([getCurrentOrg(), getSession()]);

  if (!orgData || !session?.user?.id) {
    redirect("/onboarding");
  }

  const { id } = await params;

  // Fetch client with projects
  const client = await db.query.clients.findFirst({
    where: and(
      eq(clients.id, id),
      eq(clients.organizationId, orgData.organization.id)
    ),
    with: {
      projects: {
        where: eq(projects.isArchived, false),
        orderBy: (projects, { asc }) => [asc(projects.name)],
      },
    },
  });

  if (!client) {
    notFound();
  }

  return (
    <ClientDashboard
      client={client}
      orgId={orgData.organization.id}
      currentUserId={session.user.id}
    />
  );
}

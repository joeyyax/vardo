import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { isFeatureEnabledAsync } from "@/lib/config/features";
import { db } from "@/lib/db";
import { projects } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageToolbar } from "@/components/page-toolbar";
import { DiscoverView } from "./discover-view";

export const metadata: Metadata = { title: "Discover Containers" };

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: defaultProjectId } = await searchParams;
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/login");
  }

  const containerImportEnabled = await isFeatureEnabledAsync("container-import");
  if (!containerImportEnabled) {
    redirect("/projects");
  }

  const orgId = orgData.organization.id;

  const projectList = await db.query.projects.findMany({
    where: eq(projects.organizationId, orgId),
    columns: { id: true, name: true, displayName: true },
  });

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Discover</h1>
      </PageToolbar>

      <p className="text-sm text-muted-foreground max-w-2xl">
        Running containers not yet managed by Vardo. Import a container to create an app record
        and manage future deploys from here.
      </p>

      <DiscoverView orgId={orgId} projects={projectList} defaultProjectId={defaultProjectId} />
    </div>
  );
}

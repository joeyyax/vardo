import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentActor } from "@/lib/app-services/session-actor";
import { pageData } from "@/lib/app-services/page";
import { loadDiscoverPage } from "@/lib/app-services/discover";
import { PageToolbar } from "@/components/page-toolbar";
import { DiscoverView } from "./discover-view";

export const metadata: Metadata = { title: "Discover containers" };

export default async function DiscoverPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: defaultProjectId } = await searchParams;
  const actor = await currentActor();

  if (!actor) {
    redirect("/login");
  }

  const data = await pageData(loadDiscoverPage(actor));
  if (!data) {
    redirect("/projects");
  }

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="type-h1">Discover</h1>
      </PageToolbar>

      <p className="text-sm text-muted-foreground max-w-2xl">
        Running containers not yet managed by Vardo. Import a container to create an app record
        and manage future deploys from here.
      </p>

      <DiscoverView orgId={actor.org.id} projects={data.projects} defaultProjectId={defaultProjectId} />
    </div>
  );
}

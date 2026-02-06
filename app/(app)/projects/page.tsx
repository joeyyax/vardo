import { Suspense } from "react";
import { getCurrentOrg } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ProjectsContent } from "./projects-content";

export default async function ProjectsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
      </div>

      <Suspense fallback={<ProjectsLoading />}>
        <ProjectsContent orgId={orgData.organization.id} />
      </Suspense>
    </>
  );
}

function ProjectsLoading() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="h-9 w-48 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg border bg-muted/50"
          />
        ))}
      </div>
    </div>
  );
}

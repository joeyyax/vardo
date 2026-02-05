import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ProposalsContent } from "./proposals-content";

export default async function ProposalsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Proposals</h1>
        <p className="text-muted-foreground">
          Create and track proposals across all projects.
        </p>
      </div>

      <ProposalsContent orgId={orgData.organization.id} />
    </div>
  );
}

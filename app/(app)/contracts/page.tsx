import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ContractsContent } from "./contracts-content";

export default async function ContractsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contracts</h1>
        <p className="text-muted-foreground">
          Manage contracts across all projects.
        </p>
      </div>

      <ContractsContent orgId={orgData.organization.id} />
    </div>
  );
}

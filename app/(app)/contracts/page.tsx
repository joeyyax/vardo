import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ContractsContent } from "./contracts-content";

export default async function ContractsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Contracts</h1>
      </div>

      <ContractsContent orgId={orgData.organization.id} />
    </>
  );
}

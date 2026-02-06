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
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Proposals</h1>
      </div>

      <ProposalsContent orgId={orgData.organization.id} />
    </div>
  );
}

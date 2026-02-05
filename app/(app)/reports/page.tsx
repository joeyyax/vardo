import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ReportsPageContent } from "./reports-page-content";

export default async function ReportsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-muted-foreground">
          Analytics, summaries, and shareable reports.
        </p>
      </div>

      <ReportsPageContent orgId={orgData.organization.id} />
    </div>
  );
}

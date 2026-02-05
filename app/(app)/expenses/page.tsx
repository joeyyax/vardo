import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { ExpensesContent } from "./expenses-content";

export default async function ExpensesPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Expenses</h1>
        <p className="text-muted-foreground">
          Track expenses across all projects.
        </p>
      </div>

      <ExpensesContent orgId={orgData.organization.id} />
    </div>
  );
}

import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { InvoicesContent } from "./invoices-content";

export default async function InvoicesPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invoices</h1>
        <p className="text-muted-foreground">
          Generate and manage invoices from your time entries.
        </p>
      </div>

      <InvoicesContent orgId={orgData.organization.id} />
    </div>
  );
}

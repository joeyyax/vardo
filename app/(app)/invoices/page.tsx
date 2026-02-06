import { redirect } from "next/navigation";
import { getCurrentOrg } from "@/lib/auth/session";
import { InvoicesContent } from "./invoices-content";

export default async function InvoicesPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <>
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Invoices</h1>
      </div>

      <InvoicesContent orgId={orgData.organization.id} />
    </>
  );
}

import { Suspense } from "react";
import { getCurrentOrg } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { ClientsContent } from "./clients-content";

export default async function ClientsPage() {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Clients</h1>
        <p className="text-muted-foreground">
          Manage your clients and their billing settings.
        </p>
      </div>

      <Suspense fallback={<ClientsLoading />}>
        <ClientsContent orgId={orgData.organization.id} />
      </Suspense>
    </div>
  );
}

function ClientsLoading() {
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
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

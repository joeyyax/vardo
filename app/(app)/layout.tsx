import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TopNav } from "@/components/layout/top-nav";
import { CommandPalette } from "@/components/command-palette";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { isFeatureEnabled } from "@/lib/config/features";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isFeatureEnabled("ui")) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-background">
        <div className="text-center space-y-2">
          <h1 className="text-lg font-semibold">Host</h1>
          <p className="text-sm text-muted-foreground">
            Web UI is disabled. Use the API at <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/api/v1/</code>
          </p>
        </div>
      </div>
    );
  }

  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization } = orgData;
  const organizations = await getUserOrganizations();

  return (
    <TooltipProvider>
      <div className="flex flex-col h-dvh bg-sidebar">
        {/* Top Navigation */}
        <TopNav
          currentOrgId={organization.id}
          organizations={organizations}
        />

        {/* Main Content */}
        <div className="flex-1 overflow-y-auto bg-background rounded-t-2xl min-h-0">
          <main className="mx-auto max-w-screen-xl px-5 py-8 lg:px-10 min-h-full">
            {children}
          </main>
        </div>
      </div>

      <CommandPalette orgId={organization.id} />
    </TooltipProvider>
  );
}

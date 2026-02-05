import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, MobileSidebar, EntryBar } from "@/components/layout";
import { CommandPalette } from "@/components/command-palette";
import { getCurrentOrg } from "@/lib/auth/session";
import { DEFAULT_ORG_FEATURES, type OrgFeatures } from "@/lib/db/schema";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/onboarding");
  }

  const { organization } = orgData;

  // Merge org features with defaults (handle legacy orgs without features)
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  return (
    <TooltipProvider>
      <div className="flex h-dvh bg-background">
        {/* Desktop Sidebar */}
        <div className="hidden lg:block">
          <Sidebar currentOrgId={organization.id} features={features} />
        </div>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Top Bar with Entry Bar */}
          <header className="relative flex h-auto min-h-14 items-center gap-3 border-b bg-background px-4 py-3">
            <MobileSidebar currentOrgId={organization.id} features={features} />
            {features.time_tracking && (
              <div className="flex-1">
                <EntryBar
                  orgId={organization.id}
                  roundingIncrement={organization.roundingIncrement ?? 15}
                />
              </div>
            )}
          </header>

          {/* Page Content */}
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
        </div>

        {/* Command Palette */}
        <CommandPalette orgId={organization.id} />
      </div>
    </TooltipProvider>
  );
}

import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, MobileSidebar, EntryBar } from "@/components/layout";
import { CommandPalette } from "@/components/command-palette";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
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
  const organizations = await getUserOrganizations();

  // Merge org features with defaults (handle legacy orgs without features)
  const features: OrgFeatures = {
    ...DEFAULT_ORG_FEATURES,
    ...(organization.features as OrgFeatures | null),
  };

  return (
    <TooltipProvider>
      <div data-main-content className="flex h-dvh bg-sidebar transition-transform duration-300 ease-out origin-bottom">
        {/* Desktop Sidebar */}
        <div className="hidden lg:block">
          <Sidebar
            currentOrgId={organization.id}
            features={features}
            organizations={organizations}
          />
        </div>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden bg-background squircle lg:rounded-l-2xl">
          {/* Mobile nav trigger */}
          <div className="lg:hidden flex items-center gap-3 px-4 pt-3">
            <MobileSidebar
              currentOrgId={organization.id}
              features={features}
              organizations={organizations}
            />
          </div>

          {/* Floating Entry Bar */}
          {features.time_tracking && (
            <div className="px-3 lg:px-4 pt-3 lg:pt-4 pb-0 shrink-0">
              <div className="squircle rounded-xl border bg-card shadow-sm px-4 py-3">
                <EntryBar
                  orgId={organization.id}
                  roundingIncrement={organization.roundingIncrement ?? 15}
                />
              </div>
            </div>
          )}

          {/* Page Content */}
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
        </div>

        {/* Command Palette */}
        <CommandPalette orgId={organization.id} />
      </div>
    </TooltipProvider>
  );
}

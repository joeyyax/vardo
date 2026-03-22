import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Sidebar, MobileSidebar } from "@/components/layout";
import { CommandPalette } from "@/components/command-palette";
import { getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";


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

  return (
    <TooltipProvider>
      <div data-main-content className="flex h-dvh bg-sidebar transition-transform duration-300 ease-out origin-bottom">
        {/* Desktop Sidebar */}
        <div className="hidden lg:block">
          <Sidebar
            currentOrgId={organization.id}
            organizations={organizations}
          />
        </div>

        {/* Main Content */}
        <div className="flex flex-1 flex-col overflow-hidden bg-background squircle lg:rounded-l-2xl">
          {/* Mobile nav trigger */}
          <div className="lg:hidden flex items-center gap-3 px-4 pt-3">
            <MobileSidebar
              currentOrgId={organization.id}
              organizations={organizations}
            />
          </div>

          {/* Page Content */}
          <main className="flex-1 overflow-y-auto p-4 lg:p-6">{children}</main>
        </div>

        {/* Command Palette */}
        <CommandPalette orgId={organization.id} />
      </div>
    </TooltipProvider>
  );
}

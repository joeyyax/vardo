import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TopNav } from "@/components/layout/top-nav";
import { CommandPalette } from "@/components/command-palette";
import { NotificationListener } from "@/components/notification-listener";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { isFeatureEnabled } from "@/lib/config/features";
import { SessionFooter } from "@/components/layout/session-footer";
import { UpdateBanner } from "@/components/layout/update-banner";

export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
  },
};

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!isFeatureEnabled("ui")) {
    return (
      <div className="flex items-center justify-center min-h-dvh bg-background">
        <div className="text-center space-y-2">
          <h1 className="text-lg font-semibold">Vardo</h1>
          <p className="text-sm text-muted-foreground">
            Web UI is disabled. Use the API at <code className="bg-muted px-1.5 py-0.5 rounded text-xs">/api/v1/</code>
          </p>
        </div>
      </div>
    );
  }

  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const orgData = await getCurrentOrg();

  if (!orgData) {
    redirect("/create-org");
  }

  const { organization } = orgData;
  const organizations = await getUserOrganizations();

  return (
    <TooltipProvider>
      <div className="min-h-dvh flex flex-col bg-background">
        <div className="sticky top-0 z-40 bg-sidebar">
          <TopNav
            currentOrgId={organization.id}
            organizations={organizations}
          />
        </div>

        <UpdateBanner />

        <main className="mx-auto max-w-screen-xl px-5 py-8 lg:px-10 flex-1 w-full">
          {children}
        </main>

        <SessionFooter />
      </div>

      <CommandPalette orgId={organization.id} />
      <NotificationListener orgId={organization.id} />
    </TooltipProvider>
  );
}

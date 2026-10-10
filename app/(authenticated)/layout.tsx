import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TermScope } from "@/components/term";
import { TopNav } from "@/components/layout/top-nav";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { NotificationListener } from "@/components/notification-listener";
import { getSession, getCurrentOrg, getUserOrganizations } from "@/lib/auth/session";
import { isFeatureEnabled, isFeatureEnabledAsync } from "@/lib/config/features";
import { SessionFooter } from "@/components/layout/session-footer";
import { AttentionBar } from "@/components/layout/attention-bar";
import { AttentionProvider } from "@/components/attention-provider";
import { CapabilitiesProvider } from "@/components/capabilities-provider";
import { capabilitiesFor } from "@/lib/auth/permissions";
import { isAppAdmin } from "@/lib/auth/admin";


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
          <h1 className="type-h2">Vardo</h1>
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
  const instanceAdmin = await isAppAdmin();
  const [teamsEnabled, activityEnabled, cronEnabled] = await Promise.all([
    isFeatureEnabledAsync("teams"),
    isFeatureEnabledAsync("activity"),
    isFeatureEnabledAsync("cron"),
  ]);

  return (
    <CapabilitiesProvider capabilities={capabilitiesFor(orgData.membership, { instanceAdmin })}>
      <TooltipProvider>
        <AttentionProvider orgId={organization.id}>
          <div className="min-h-dvh flex flex-col bg-background">
            <div className="sticky top-0 z-40 bg-sidebar">
              <TopNav
                currentOrgId={organization.id}
                organizations={organizations}
                teamsEnabled={teamsEnabled}
                activityEnabled={activityEnabled}
                cronEnabled={cronEnabled}
              />
              <AttentionBar />
            </div>

            <main className="flex-1">
              <section className="py-10 sm:py-14">
                <div className="container">
                  <TermScope>{children}</TermScope>
                </div>
              </section>
            </main>

            <SessionFooter />
          </div>

          <CommandPalette
            orgId={organization.id}
            teamsEnabled={teamsEnabled}
            activityEnabled={activityEnabled}
            cronEnabled={cronEnabled}
          />
          <KeyboardShortcuts />
          <NotificationListener orgId={organization.id} canLinkToAdmin={instanceAdmin} />
        </AttentionProvider>
      </TooltipProvider>
    </CapabilitiesProvider>
  );
}

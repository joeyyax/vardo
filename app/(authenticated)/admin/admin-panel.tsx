"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SectionNav, type SectionGroup } from "@/components/section-nav";
import { PageToolbar } from "@/components/page-toolbar";
import { FeatureDisabled } from "@/components/feature-disabled";
import { DockerPrune, UserManagement } from "./admin-actions";
import { AdminOverview } from "./admin-overview";
import { AdminOrganizations } from "./admin-organizations";
import { AdminMetrics } from "./admin-metrics";


type AdminPanelProps = {
  activeTab: string;
  orgId: string;
  metricsEnabled: boolean;
  metricsFlag: { label: string; description: string };
};

export function AdminPanel({ activeTab, orgId, metricsEnabled, metricsFlag }: AdminPanelProps) {
  const router = useRouter();

  function setActiveTab(tab: string) {
    router.push(tab === "overview" ? "/admin" : `/admin/${tab}`, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <Button variant="outline" size="sm" className="squircle gap-2" asChild>
            <Link href="/admin/settings">
              <Settings className="size-4" />
              System settings
            </Link>
          </Button>
        }
      >
        <h1 className="type-h1">Admin</h1>
      </PageToolbar>

      {/* Sections — vertical nav rail on lg+, scroll strip below */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        orientation="vertical"
        className="flex-col gap-6 lg:flex-row lg:gap-8"
      >
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SectionNav
              groups={[
                { items: [{ value: "overview", label: "Overview" }] },
                {
                  label: "Manage",
                  items: [
                    { value: "organizations", label: "Organizations" },
                    { value: "users", label: "Users" },
                  ],
                },
                {
                  label: "Operate",
                  items: [
                    { value: "maintenance", label: "Maintenance" },
                    { value: "metrics", label: "Metrics" },
                  ],
                },
              ] satisfies SectionGroup[]}
            />
          </div>
        </aside>

        <div className="min-w-0 flex-1">

        <TabsContent value="overview">
          <AdminOverview />
        </TabsContent>

        <TabsContent value="organizations">
          <AdminOrganizations />
        </TabsContent>

        <TabsContent value="users">
          <UserManagement />
        </TabsContent>

        <TabsContent value="maintenance" className="space-y-4">
          <DockerPrune />
        </TabsContent>

        <TabsContent value="metrics">
          {metricsEnabled ? (
            <AdminMetrics orgId={orgId} />
          ) : (
            <FeatureDisabled name={metricsFlag.label} description={metricsFlag.description} canManage />
          )}
        </TabsContent>

        </div>
      </Tabs>
    </div>
  );
}

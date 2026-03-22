"use client";

import { useRouter } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageToolbar } from "@/components/page-toolbar";
import { DockerPrune, UserManagement } from "./admin-actions";
import { AdminOverview } from "./admin-overview";
import { AdminSystem } from "./admin-system";
import { AdminOrganizations } from "./admin-organizations";
import { AdminMetrics } from "./admin-metrics";

type AdminPanelProps = {
  activeTab: string;
  orgId: string;
};

export function AdminPanel({ activeTab, orgId }: AdminPanelProps) {
  const router = useRouter();

  function setActiveTab(tab: string) {
    router.push(tab === "overview" ? "/admin" : `/admin/${tab}`, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
      </PageToolbar>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="system">System</TabsTrigger>
          <TabsTrigger value="organizations">Organizations</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <AdminOverview />
        </TabsContent>

        <TabsContent value="system" className="pt-4">
          <AdminSystem />
        </TabsContent>

        <TabsContent value="organizations" className="pt-4">
          <AdminOrganizations />
        </TabsContent>

        <TabsContent value="users" className="pt-4">
          <UserManagement />
        </TabsContent>

        <TabsContent value="maintenance" className="pt-4 space-y-4">
          <DockerPrune />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <AdminMetrics orgId={orgId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

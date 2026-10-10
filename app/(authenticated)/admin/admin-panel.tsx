"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { SectionNav, type SectionGroup } from "@/components/section-nav";
import { PageToolbar } from "@/components/page-toolbar";
import { UserManagement } from "./admin-actions";
import { AdminOverview } from "./admin-overview";
import { AdminOrganizations } from "./admin-organizations";


type AdminPanelProps = {
  activeTab: string;
};

export function AdminPanel({ activeTab }: AdminPanelProps) {
  const router = useRouter();

  const tabPath = (tab: string) => (tab === "overview" ? "/admin" : `/admin/${tab}`);

  function setActiveTab(tab: string) {
    router.push(tabPath(tab), { scroll: false });
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <Button variant="outline" size="sm" className="gap-2" asChild>
            <Link href="/admin/settings">
              <Settings className="size-4" />
              System settings
            </Link>
          </Button>
        }
      >
        <h1 className="type-h1">Admin</h1>
      </PageToolbar>

      {/* Sections */}
      <Tabs
        value={activeTab}
        onValueChange={setActiveTab}
        orientation="vertical"
        className="flex-col gap-6 lg:flex-row lg:gap-8"
      >
        <aside className="lg:w-48 lg:shrink-0">
          <div className="lg:sticky lg:top-24">
            <SectionNav
              label="Admin sections"
              hrefFor={tabPath}
              groups={[
                { items: [{ value: "overview", label: "Overview" }] },
                {
                  label: "Manage",
                  items: [
                    { value: "organizations", label: "Organizations" },
                    { value: "users", label: "Users" },
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

        </div>
      </Tabs>
    </div>
  );
}

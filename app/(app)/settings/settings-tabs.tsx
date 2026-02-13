"use client";

import type { ReactNode } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

type SettingsTabsProps = {
  generalContent: ReactNode;
  workflowContent: ReactNode;
  billingContent: ReactNode;
  teamContent: ReactNode;
  integrationsContent: ReactNode;
};

export function SettingsTabs({
  generalContent,
  workflowContent,
  billingContent,
  teamContent,
  integrationsContent,
}: SettingsTabsProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const currentTab = searchParams.get("tab") || "general";

  function handleTabChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value === "general") {
      params.delete("tab");
    } else {
      params.set("tab", value);
    }
    const qs = params.toString();
    router.replace(qs ? `/settings?${qs}` : "/settings", { scroll: false });
  }

  return (
    <Tabs value={currentTab} onValueChange={handleTabChange}>
      <TabsList>
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="workflow">Workflow</TabsTrigger>
        <TabsTrigger value="billing">Billing</TabsTrigger>
        <TabsTrigger value="team">Team</TabsTrigger>
        <TabsTrigger value="integrations">Integrations</TabsTrigger>
      </TabsList>

      <TabsContent value="general" className="mt-6 space-y-8">
        {generalContent}
      </TabsContent>

      <TabsContent value="workflow" className="mt-6 space-y-8">
        {workflowContent}
      </TabsContent>

      <TabsContent value="billing" className="mt-6 space-y-8">
        {billingContent}
      </TabsContent>

      <TabsContent value="team" className="mt-6 space-y-8">
        {teamContent}
      </TabsContent>

      <TabsContent value="integrations" className="mt-6 space-y-8">
        {integrationsContent}
      </TabsContent>
    </Tabs>
  );
}

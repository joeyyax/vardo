"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReportsContent } from "./reports-content";
import { ReportConfigs } from "@/components/reports/report-configs";
import { BarChart3, Share2 } from "lucide-react";

type ReportsPageContentProps = {
  orgId: string;
};

export function ReportsPageContent({ orgId }: ReportsPageContentProps) {
  return (
    <Tabs defaultValue="analytics" className="space-y-6">
      <TabsList className="squircle">
        <TabsTrigger value="analytics" className="gap-2">
          <BarChart3 className="size-4" />
          Analytics
        </TabsTrigger>
        <TabsTrigger value="shared" className="gap-2">
          <Share2 className="size-4" />
          Shared Reports
        </TabsTrigger>
      </TabsList>

      <TabsContent value="analytics" className="mt-6">
        <ReportsContent orgId={orgId} />
      </TabsContent>

      <TabsContent value="shared" className="mt-6">
        <ReportConfigs orgId={orgId} />
      </TabsContent>
    </Tabs>
  );
}

"use client";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { EmailSettings } from "./system/email-settings";
import { BackupSettings } from "./system/backup-settings";
import { GitHubSettings } from "./system/github-settings";
import { ServicesSettings } from "./system/services-settings";

export function SystemSettings({ defaultTab }: { defaultTab?: string }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">System</h2>
        <p className="text-sm text-muted-foreground">
          Platform-wide configuration. Only visible to app admins.
        </p>
      </div>

      <Tabs defaultValue={defaultTab || "email"}>
        <TabsList variant="line">
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="backup">Backup storage</TabsTrigger>
          <TabsTrigger value="github">GitHub App</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
        </TabsList>

        <TabsContent value="email" className="pt-4">
          <EmailSettings />
        </TabsContent>

        <TabsContent value="backup" className="pt-4">
          <BackupSettings />
        </TabsContent>

        <TabsContent value="github" className="pt-4">
          <GitHubSettings />
        </TabsContent>

        <TabsContent value="services" className="pt-4">
          <ServicesSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

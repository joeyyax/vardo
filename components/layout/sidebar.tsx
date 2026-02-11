"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "@/components/notification-bell";
import { Separator } from "@/components/ui/separator";
import type { OrgFeatures } from "@/lib/db/schema";
import { Brand } from "../brand";

type Organization = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

type SidebarProps = {
  currentOrgId?: string;
  features?: OrgFeatures;
  organizations?: Organization[];
};

export function Sidebar({ currentOrgId, features, organizations }: SidebarProps) {
  // Determine default route based on features
  const defaultRoute = features?.time_tracking ? "/track" : "/projects";

  return (
    <aside className="flex h-full w-56 flex-col border-r bg-sidebar">
      {/* Logo/Brand */}
      <div className="flex h-14 items-center justify-between px-4">
        <Brand />
        <NotificationBell />
      </div>

      <Separator />

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav features={features} />
      </div>

      {/* Footer - Org Switcher & User Menu */}
      <div className="mt-auto border-t p-2">
        <div className="flex flex-col gap-1">
          <OrgSwitcher currentOrgId={currentOrgId} organizations={organizations} />
          <UserMenu />
        </div>
      </div>
    </aside>
  );
}

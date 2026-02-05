"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import { Separator } from "@/components/ui/separator";
import type { OrgFeatures } from "@/lib/db/schema";

type SidebarProps = {
  currentOrgId?: string;
  features?: OrgFeatures;
};

export function Sidebar({ currentOrgId, features }: SidebarProps) {
  // Determine default route based on features
  const defaultRoute = features?.time_tracking ? "/track" : "/projects";

  return (
    <aside className="flex h-full w-56 flex-col border-r bg-sidebar">
      {/* Logo/Brand */}
      <div className="flex h-14 items-center gap-2 px-4">
        <Link href={defaultRoute} className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Clock className="size-4" />
          </div>
          <span className="text-lg font-semibold">Time</span>
        </Link>
      </div>

      <Separator />

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav features={features} />
      </div>

      {/* Footer - Org Switcher & User Menu */}
      <div className="mt-auto border-t p-2">
        <div className="flex flex-col gap-1">
          <OrgSwitcher currentOrgId={currentOrgId} />
          <UserMenu />
        </div>
      </div>
    </aside>
  );
}

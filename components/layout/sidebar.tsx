"use client";

import { useState, useEffect } from "react";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "@/components/notification-bell";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OrgFeatures } from "@/lib/db/schema";
import { Brand } from "../brand";
import {
  getUserPreference,
  setUserPreference,
} from "@/lib/user-preferences";

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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(getUserPreference("sidebarCollapsed"));
  }, []);

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    setUserPreference("sidebarCollapsed", next);
  };

  return (
    <aside
      className={`flex h-full flex-col bg-sidebar transition-[width] duration-200 ${
        collapsed ? "w-14" : "w-56"
      }`}
    >
      {/* Header */}
      <div className="flex h-14 items-center justify-between px-4">
        {collapsed ? (
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 mx-auto"
                onClick={toggleCollapsed}
              >
                <PanelLeft className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          </Tooltip>
        ) : (
          <>
            <Brand />
            <div className="flex items-center gap-1">
              <NotificationBell />
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    onClick={toggleCollapsed}
                  >
                    <PanelLeftClose className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">Collapse sidebar</TooltipContent>
              </Tooltip>
            </div>
          </>
        )}
      </div>

      <Separator />

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto py-4">
        <SidebarNav features={features} collapsed={collapsed} />
      </div>

      {/* Footer - Org Switcher & User Menu */}
      <div className="mt-auto border-t p-2">
        <div className="flex flex-col gap-1">
          <OrgSwitcher
            currentOrgId={currentOrgId}
            organizations={organizations}
            collapsed={collapsed}
          />
          <UserMenu collapsed={collapsed} />
        </div>
      </div>
    </aside>
  );
}

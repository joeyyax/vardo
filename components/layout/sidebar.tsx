"use client";

import { useState } from "react";
import { PanelLeftClose, PanelLeft } from "lucide-react";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Brand } from "../brand";
import type { Organization } from "@/lib/types";

type SidebarProps = {
  currentOrgId?: string;
  organizations?: Organization[];
};

export function Sidebar({ currentOrgId, organizations }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const toggleCollapsed = () => {
    setCollapsed(!collapsed);
  };

  return (
    <aside
      className={`flex h-full flex-col bg-sidebar transition-[width] duration-200 ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Header */}
      <div className="flex h-16 items-center justify-between px-5">
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
      <div className="flex-1 overflow-y-auto py-5">
        <SidebarNav collapsed={collapsed} orgId={currentOrgId} />
      </div>

      {/* Footer - Org Switcher & User Menu */}
      <div className="mt-auto border-t p-3">
        <div className="flex flex-col gap-1.5">
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

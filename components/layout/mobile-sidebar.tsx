"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarNav } from "./sidebar-nav";
import { Brand } from "../brand";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import type { Organization } from "@/lib/types";

type MobileSidebarProps = {
  currentOrgId?: string;
  organizations?: Organization[];
  teamsEnabled?: boolean;
};

export function MobileSidebar({ currentOrgId, organizations, teamsEnabled = true }: MobileSidebarProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu className="size-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="surface-sidebar w-64 p-0">
        <SheetHeader className="flex h-16 flex-row items-center justify-between px-5 border-b">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Brand />
        </SheetHeader>

        <div className="flex h-[calc(100%-4rem)] flex-col">
          {/* Navigation */}
          <div className="flex-1 overflow-y-auto py-5">
            <SidebarNav orgId={currentOrgId} />
          </div>

          {/* Footer - Org Switcher & User Menu */}
          <div className="mt-auto border-t p-3">
            <div className="flex flex-col gap-1.5">
              {teamsEnabled && (
                <OrgSwitcher currentOrgId={currentOrgId} organizations={organizations} />
              )}
              <UserMenu teamsEnabled={teamsEnabled} />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

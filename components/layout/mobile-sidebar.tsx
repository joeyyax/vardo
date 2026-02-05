"use client";

import { Menu, Clock } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { SidebarNav } from "./sidebar-nav";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";
import { NotificationBell } from "@/components/notification-bell";
import type { OrgFeatures } from "@/lib/db/schema";

type MobileSidebarProps = {
  currentOrgId?: string;
  features?: OrgFeatures;
};

export function MobileSidebar({ currentOrgId, features }: MobileSidebarProps) {
  // Determine default route based on features
  const defaultRoute = features?.time_tracking ? "/track" : "/projects";

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu className="size-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="flex h-14 flex-row items-center justify-between px-4 border-b">
          <Link href={defaultRoute} className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Clock className="size-4" />
            </div>
            <SheetTitle className="text-lg font-semibold">Time</SheetTitle>
          </Link>
          <NotificationBell />
        </SheetHeader>

        <div className="flex h-[calc(100%-3.5rem)] flex-col">
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
        </div>
      </SheetContent>
    </Sheet>
  );
}

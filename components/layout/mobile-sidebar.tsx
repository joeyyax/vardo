"use client";

import { Menu, FolderKanban } from "lucide-react";
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
import type { Organization } from "@/lib/types";

type MobileSidebarProps = {
  currentOrgId?: string;
  organizations?: Organization[];
};

export function MobileSidebar({ currentOrgId, organizations }: MobileSidebarProps) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden">
          <Menu className="size-5" />
          <span className="sr-only">Toggle menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-64 p-0">
        <SheetHeader className="flex h-16 flex-row items-center justify-between px-5 border-b">
          <Link href="/projects" className="flex items-center gap-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <FolderKanban className="size-4" />
            </div>
            <SheetTitle className="text-lg font-semibold">Vardo</SheetTitle>
          </Link>
        </SheetHeader>

        <div className="flex h-[calc(100%-4rem)] flex-col">
          {/* Navigation */}
          <div className="flex-1 overflow-y-auto py-5">
            <SidebarNav orgId={currentOrgId} />
          </div>

          {/* Footer - Org Switcher & User Menu */}
          <div className="mt-auto border-t p-3">
            <div className="flex flex-col gap-1.5">
              <OrgSwitcher currentOrgId={currentOrgId} organizations={organizations} />
              <UserMenu />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

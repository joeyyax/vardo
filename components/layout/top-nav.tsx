"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Brand } from "../brand";
import { UserMenu } from "./user-menu";
import { MobileSidebar } from "./mobile-sidebar";
import { openCommandPalette } from "@/components/command-palette";
import type { Organization } from "@/lib/types";

type TopNavProps = {
  currentOrgId?: string;
  organizations?: Organization[];
  teamsEnabled?: boolean;
  activityEnabled?: boolean;
};

const navItems = [
  { label: "Projects", href: "/projects" },
  { label: "Metrics", href: "/metrics" },
  { label: "Backups", href: "/backups" },
  { label: "Activity", href: "/activity", requires: "activity" as const },
];

export function TopNav({ currentOrgId, organizations, teamsEnabled = true, activityEnabled = true }: TopNavProps) {
  const pathname = usePathname();
  const visibleNavItems = navItems.filter(
    (item) => item.requires !== "activity" || activityEnabled,
  );

  return (
    <header className="surface-sidebar bg-sidebar border-b shrink-0">
      <div className="container flex items-center h-16 gap-4">
        {/* Left: hamburger (mobile) + brand */}
        <div className="flex-1 flex items-center gap-2">
          <MobileSidebar
            currentOrgId={currentOrgId}
            organizations={organizations}
            teamsEnabled={teamsEnabled}
          />
          <Brand />
        </div>

        {/* Center: nav (hidden on mobile) */}
        <nav className="hidden lg:flex items-center gap-1">
          {visibleNavItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {/* Right: search hint + user (hidden on mobile — available in sidebar) */}
        <div className="flex-1 flex justify-end items-center gap-2">
          <button
            type="button"
            onClick={openCommandPalette}
            className="hidden lg:flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm text-sidebar-foreground/50 transition-colors hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span>Search</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
          </button>
          <div className="hidden lg:block">
            <UserMenu
              currentOrgId={currentOrgId}
              organizations={organizations}
              teamsEnabled={teamsEnabled}
            />
          </div>
        </div>
      </div>
    </header>
  );
}

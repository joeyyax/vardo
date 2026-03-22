"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Brand } from "../brand";
import { UserMenu } from "./user-menu";
import type { Organization } from "@/lib/types";

type TopNavProps = {
  currentOrgId?: string;
  organizations?: Organization[];
};

const navItems = [
  { label: "Projects", href: "/projects" },
  { label: "Metrics", href: "/metrics" },
  { label: "Backups", href: "/backups" },
  { label: "Activity", href: "/activity" },
];

export function TopNav({ currentOrgId, organizations }: TopNavProps) {
  const pathname = usePathname();

  return (
    <header className="bg-sidebar shrink-0">
      <div className="mx-auto max-w-screen-xl flex items-center h-16 px-5 lg:px-8 gap-4">
        {/* Left: brand */}
        <div className="flex-1">
          <Brand />
        </div>

        {/* Center: nav */}
        <nav className="flex items-center gap-1">
          {navItems.map((item) => {
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

        {/* Right: user */}
        <div className="flex-1 flex justify-end">
          <UserMenu
            currentOrgId={currentOrgId}
            organizations={organizations}
          />
        </div>
      </div>
    </header>
  );
}

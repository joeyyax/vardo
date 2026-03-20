"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Settings, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";

// Note: OrgSwitcher uses w-full which was for the sidebar.
// In top nav context it works fine since it's in a flex container.

type Organization = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

type TopNavProps = {
  currentOrgId?: string;
  organizations?: Organization[];
};

const navItems = [
  { label: "Projects", href: "/projects", icon: FolderKanban },
  { label: "Settings", href: "/settings", icon: Settings },
  { label: "Admin", href: "/admin", icon: Shield },
];

export function TopNav({ currentOrgId, organizations }: TopNavProps) {
  const pathname = usePathname();

  return (
    <header className="bg-sidebar shrink-0">
      <div className="mx-auto max-w-screen-xl flex items-center h-14 px-4 lg:px-8 gap-4">
        {/* Left: org */}
        <div className="flex items-center shrink-0">
          <OrgSwitcher
            currentOrgId={currentOrgId}
            organizations={organizations}
            collapsed={false}
          />
        </div>

        {/* Center: nav */}
        <nav className="flex items-center gap-1 flex-1 justify-center">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                )}
              >
                <Icon className="size-4" />
                <span className="hidden sm:inline">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Right: user */}
        <div className="shrink-0">
          <UserMenu collapsed={false} />
        </div>
      </div>
    </header>
  );
}

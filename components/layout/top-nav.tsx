"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FolderKanban, Settings, Shield } from "lucide-react";
import { cn } from "@/lib/utils";
import { Brand } from "../brand";
import { OrgSwitcher } from "./org-switcher";
import { UserMenu } from "./user-menu";

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
    <header className="flex items-center justify-between h-14 px-4 lg:px-6 bg-sidebar shrink-0">
      {/* Left: brand + nav */}
      <div className="flex items-center gap-6">
        <Brand />
        <nav className="flex items-center gap-1">
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
      </div>

      {/* Right: org + user */}
      <div className="flex items-center gap-2">
        <OrgSwitcher
          currentOrgId={currentOrgId}
          organizations={organizations}
          collapsed={false}
        />
        <UserMenu collapsed={false} />
      </div>
    </header>
  );
}

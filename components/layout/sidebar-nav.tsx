"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderKanban,
  Settings,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
};

const navItems: NavItem[] = [
  {
    label: "Projects",
    href: "/projects",
    icon: FolderKanban,
    description: "Manage deployed projects",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Organization settings",
  },
  {
    label: "Admin",
    href: "/admin",
    icon: Shield,
    description: "System administration",
  },
];

type SidebarNavProps = {
  collapsed?: boolean;
  orgId?: string;
};

export function SidebarNav({ collapsed }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1 px-2">
      {navItems.map((item, index) => {
        const isActive =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Fragment key={item.href}>
            {index > 0 && item.href === "/settings" && (
              <div className="my-1.5" />
            )}
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center rounded-md py-2 text-sm font-medium transition-colors",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    collapsed ? "justify-center px-2" : "gap-3 px-3",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70"
                  )}
                >
                  <div className="relative shrink-0">
                    <Icon className="size-4" />
                  </div>
                  {!collapsed && (
                    <span className="truncate flex-1">{item.label}</span>
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right" className={collapsed ? "" : "hidden lg:block"}>
                {collapsed ? item.label : item.description}
              </TooltipContent>
            </Tooltip>
          </Fragment>
        );
      })}
    </nav>
  );
}

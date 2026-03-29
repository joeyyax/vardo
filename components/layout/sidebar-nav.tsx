"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderKanban,
  Shield,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useSession } from "@/lib/auth/client";

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
    description: "Manage deployed apps",
  },
];

const adminNavItem: NavItem = {
  label: "Admin",
  href: "/admin",
  icon: Shield,
  description: "System administration",
};

type SidebarNavProps = {
  collapsed?: boolean;
  orgId?: string;
};

export function SidebarNav({ collapsed }: SidebarNavProps) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const isAdmin = !!session?.user?.isAppAdmin;
  const items = isAdmin ? [...navItems, adminNavItem] : navItems;

  return (
    <nav className="flex flex-col gap-1 px-3">
      {items.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <div key={item.href}>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors",
                    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    collapsed ? "justify-center px-2.5" : "gap-3 px-3",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70"
                  )}
                >
                  <div className="relative shrink-0">
                    <Icon className="size-4.5" />
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
          </div>
        );
      })}
    </nav>
  );
}

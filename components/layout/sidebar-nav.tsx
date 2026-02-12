"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Clock,
  BarChart3,
  FileText,
  FileSignature,
  FileCheck,
  Receipt,
  Users,
  Folder,
  ListTodo,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { OrgFeatures } from "@/lib/db/schema";

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
  // Which feature flag enables this nav item (undefined = always show)
  feature?: keyof OrgFeatures;
  // Custom visibility check for items that depend on multiple features
  visibleWhen?: (features: OrgFeatures) => boolean;
};

const navItems: NavItem[] = [
  {
    label: "Track",
    href: "/track",
    icon: Clock,
    description: "Timeline view",
    feature: "time_tracking",
  },
  {
    label: "Reports",
    href: "/reports",
    icon: BarChart3,
    description: "Analytics & summaries",
    feature: "time_tracking",
  },
  {
    label: "Invoices",
    href: "/invoices",
    icon: FileText,
    description: "Manage invoices",
    feature: "invoicing",
  },
  {
    label: "Proposals",
    href: "/proposals",
    icon: FileSignature,
    description: "Track proposals",
    feature: "proposals",
  },
  {
    label: "Contracts",
    href: "/contracts",
    icon: FileCheck,
    description: "Manage contracts",
    feature: "proposals",
  },
  {
    label: "Expenses",
    href: "/expenses",
    icon: Receipt,
    description: "Track expenses",
    feature: "expenses",
  },
  {
    label: "Clients",
    href: "/clients",
    icon: Users,
    description: "Manage clients",
    // Always visible - core feature
  },
  {
    label: "Projects",
    href: "/projects",
    icon: Folder,
    description: "Manage projects",
    // Show if time_tracking OR pm is enabled
    visibleWhen: (features) => features.time_tracking || features.pm,
  },
  {
    label: "Tasks",
    href: "/tasks",
    icon: ListTodo,
    description: "All tasks across projects",
    feature: "pm",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Organization settings",
    // Always visible
  },
];

type SidebarNavProps = {
  features?: OrgFeatures;
  collapsed?: boolean;
};

export function SidebarNav({ features, collapsed }: SidebarNavProps) {
  const pathname = usePathname();

  // Filter nav items based on enabled features
  const visibleItems = navItems.filter((item) => {
    if (!features) return true; // Show all if no features object (backward compat)
    // Custom visibility check takes precedence
    if (item.visibleWhen) return item.visibleWhen(features);
    // Single feature flag check
    if (item.feature) return features[item.feature];
    // No feature requirement - always show
    return true;
  });

  return (
    <nav className="flex flex-col gap-1 px-2">
      {visibleItems.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;

        return (
          <Tooltip key={item.href} delayDuration={0}>
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
                <Icon className="size-4 shrink-0" />
                {!collapsed && <span className="truncate">{item.label}</span>}
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" className={collapsed ? "" : "hidden lg:block"}>
              {collapsed ? item.label : item.description}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

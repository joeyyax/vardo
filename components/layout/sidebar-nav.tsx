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
    // Always visible - core financial feature
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
    // Always visible - core feature
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
};

export function SidebarNav({ features }: SidebarNavProps) {
  const pathname = usePathname();

  // Filter nav items based on enabled features
  const visibleItems = navItems.filter((item) => {
    if (!item.feature) return true; // Always show items without feature requirement
    if (!features) return true; // Show all if no features object (backward compat)
    return features[item.feature];
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
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70"
                )}
              >
                <Icon className="size-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" className="hidden lg:block">
              {item.description}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}

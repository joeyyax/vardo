"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Clock,
  BarChart3,
  FileText,
  Users,
  Folder,
  Settings,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

const navItems = [
  {
    label: "Track",
    href: "/track",
    icon: Clock,
    description: "Timeline view",
  },
  {
    label: "Reports",
    href: "/reports",
    icon: BarChart3,
    description: "Analytics & summaries",
  },
  {
    label: "Invoices",
    href: "/invoices",
    icon: FileText,
    description: "Manage invoices",
  },
  {
    label: "Clients",
    href: "/clients",
    icon: Users,
    description: "Manage clients",
  },
  {
    label: "Projects",
    href: "/projects",
    icon: Folder,
    description: "Manage projects",
  },
  {
    label: "Settings",
    href: "/settings",
    icon: Settings,
    description: "Organization settings",
  },
]

export function SidebarNav() {
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-1 px-2">
      {navItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`)
        const Icon = item.icon

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
        )
      })}
    </nav>
  )
}

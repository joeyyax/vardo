"use client"

import { ChevronsUpDown, Plus, Building2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

// Placeholder data - will be replaced with real data later
const currentOrg = {
  id: "1",
  name: "My Workspace",
}

const organizations = [
  { id: "1", name: "My Workspace" },
  { id: "2", name: "Acme Corp" },
]

export function OrgSwitcher() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className="w-full justify-start gap-2 px-2 py-1.5 h-auto"
        >
          <div className="flex size-6 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <Building2 className="size-3.5" />
          </div>
          <span className="flex-1 truncate text-left text-sm font-medium">
            {currentOrg.name}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[--radix-dropdown-menu-trigger-width] min-w-56"
      >
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          Organizations
        </DropdownMenuLabel>
        {organizations.map((org) => (
          <DropdownMenuItem
            key={org.id}
            className="gap-2 cursor-pointer"
          >
            <div className="flex size-5 items-center justify-center rounded-sm bg-muted">
              <Building2 className="size-3" />
            </div>
            <span className="truncate">{org.name}</span>
            {org.id === currentOrg.id && (
              <span className="ml-auto text-xs text-muted-foreground">
                Current
              </span>
            )}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 cursor-pointer">
          <div className="flex size-5 items-center justify-center rounded-sm border border-dashed">
            <Plus className="size-3" />
          </div>
          <span>Create organization</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

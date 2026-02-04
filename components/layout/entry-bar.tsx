"use client"

import { Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

/**
 * Entry bar placeholder - will be fully implemented in Phase 3.1
 * Displays the quick entry form at the top of the main content area.
 */
export function EntryBar() {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card p-3 shadow-sm">
      <Input
        placeholder="What did you work on?"
        className="flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        disabled
      />
      <Button variant="outline" size="sm" disabled>
        Project / Task
      </Button>
      <Input
        placeholder="0:00"
        className="w-20 text-center border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
        disabled
      />
      <Button size="icon" disabled>
        <Plus className="size-4" />
        <span className="sr-only">Add entry</span>
      </Button>
    </div>
  )
}

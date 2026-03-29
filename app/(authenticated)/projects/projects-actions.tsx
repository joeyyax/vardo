"use client";

import Link from "next/link";
import { Plus, ChevronDown, Container } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AddAppDropdown } from "./add-app-dropdown";

export function ProjectsActions() {
  return (
    <div className="flex items-center gap-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">
            <Plus className="mr-1.5 size-4" />
            New project
            <ChevronDown className="ml-1.5 size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/projects/new">
              <Plus className="mr-2 size-4" />
              Create new
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/discover">
              <Container className="mr-2 size-4" />
              Import from Docker
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AddAppDropdown label="Deploy app" size="default" />
    </div>
  );
}

export function DeployAppButton() {
  return <AddAppDropdown label="Deploy app" />;
}

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
            <Link href="/projects/new">Create new</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/discover">
              <Container className="mr-2 size-4" />
              Import from Docker
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus className="mr-1.5 size-4" />
            Deploy app
            <ChevronDown className="ml-1.5 size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link href="/apps/new">Create new app</Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/discover">
              <Container className="mr-2 size-4" />
              Import existing container
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function DeployAppButton() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 size-4" />
          Deploy app
          <ChevronDown className="ml-1.5 size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link href="/apps/new">Create new app</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/discover">
            <Container className="mr-2 size-4" />
            Import existing container
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

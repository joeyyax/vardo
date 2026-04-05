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

interface AddAppDropdownProps {
  projectId: string;
  align?: "end" | "center" | "start";
  label?: string;
  size?: "default" | "sm";
}

export function AddAppDropdown({
  projectId,
  align = "end",
  label = "Add App",
  size = "sm",
}: AddAppDropdownProps) {
  const newAppHref = `/apps/new?project=${projectId}`;
  const discoverHref = `/discover?project=${projectId}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size={size}>
          <Plus className="mr-1.5 size-4" />
          {label}
          <ChevronDown className="ml-1.5 size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>
        <DropdownMenuItem asChild>
          <Link href={newAppHref}>
            <Plus className="mr-2 size-4" />
            Create new app
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={discoverHref}>
            <Container className="mr-2 size-4" />
            Import existing container
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

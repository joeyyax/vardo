"use client";

import Link from "next/link";
import { Check, ChevronRight, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { statusDotColor } from "@/lib/ui/status-colors";

export type Crumb = { href: string; label: string };

/** Page title with its parents as a breadcrumb above it. `children` sit on the title line. */
export function EntityTitle({
  crumbs = [],
  title,
  children,
}: {
  crumbs?: Crumb[];
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-1">
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {crumbs.map((crumb, i) => (
              <li key={crumb.href} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 opacity-50" aria-hidden="true" />}
                <Link href={crumb.href} className="hover:text-foreground transition-colors">
                  {crumb.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h1 className="type-h1 min-w-0 break-words">{title}</h1>
        {children}
      </div>
    </div>
  );
}

type SwitcherApp = { name: string; displayName: string; status: string };

/** Jump to a sibling app in the same project. */
export function AppSwitcher({ current, siblings }: { current: SwitcherApp; siblings: SwitcherApp[] }) {
  if (siblings.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label="Switch app"
        >
          <ChevronsUpDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem disabled>
          <span className={`mr-2 size-2 rounded-full ${statusDotColor(current.status)}`} />
          {current.displayName}
          <Check className="ml-auto size-3.5" />
        </DropdownMenuItem>
        {siblings.map((sibling) => (
          <DropdownMenuItem key={sibling.name} asChild>
            <Link href={`/apps/${sibling.name}`} className="flex items-center gap-2">
              <span className={`mr-2 size-2 rounded-full ${statusDotColor(sibling.status)}`} />
              {sibling.displayName}
            </Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A collapsible section's heading row: the name on the left, quiet numbers on the right. The numbers
 * wrap under the name on phones. Keyboard focus is managed by the list.
 */
export function SectionHeader({
  navKey,
  title,
  badge,
  expanded,
  onToggle,
  children,
}: {
  navKey: string;
  title: string;
  /** Beside the title, such as a system badge. */
  badge?: ReactNode;
  expanded: boolean;
  onToggle: () => void;
  /** SectionNumber items. */
  children?: ReactNode;
}) {
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-expanded={expanded}
      aria-label={title}
      aria-selected={false}
      tabIndex={-1}
      data-nav={navKey}
      onClick={onToggle}
      className="squircle flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 rounded-md py-1.5 pr-3 pl-1.5 outline-none hover:bg-row-hover focus-visible:bg-row-hover focus-visible:shadow-[inset_2px_0_0_var(--brass)]"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ChevronRight
          aria-hidden="true"
          className={cn("size-5 shrink-0 p-0.5 text-muted-foreground/70 transition-transform", expanded && "rotate-90")}
        />
        <h2 className="type-h3 truncate">{title}</h2>
        {badge}
      </span>
      {children && (
        <span className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-0.5 text-[13px] text-muted-foreground/75 max-sm:ml-7 max-sm:w-full max-sm:gap-x-4">
          {children}
        </span>
      )}
    </div>
  );
}

/** One quiet number in a section header. `optional` ones drop on phones. */
export function SectionNumber({
  children,
  optional = false,
  tone,
  title,
}: {
  children: ReactNode;
  optional?: boolean;
  /** A text class for a number that is a problem. */
  tone?: string;
  title?: string;
}) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1.5 whitespace-nowrap", optional && "max-sm:hidden", tone)}>
      {children}
    </span>
  );
}

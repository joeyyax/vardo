"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { EntityLink } from "@/components/entity-link";
import { cn } from "@/lib/utils";

/**
 * A collapsible section's heading row: the name on the left, quiet numbers on the right. The numbers
 * wrap under the name on phones. Keyboard focus is managed by the list.
 */
export function SectionHeader({
  navKey,
  title,
  href,
  badge,
  star,
  expanded,
  onToggle,
  children,
}: {
  navKey: string;
  title: string;
  /** The page the title links to. The rest of the row folds the section. */
  href?: string;
  /** Beside the title, such as a system badge. */
  badge?: ReactNode;
  /** A star toggle after the title. */
  star?: ReactNode;
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
      className="group/row flex min-h-12 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-1.5 pr-3 outline-none"
    >
      {/* The chevron hangs in the gutter so the title lines up with the card below. */}
      <span className="flex min-w-0 items-center gap-2 sm:-ml-7">
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-5 shrink-0 p-0.5 text-muted-foreground/70 transition-[rotate,color] group-hover/row:text-foreground group-focus-visible/row:text-foreground",
            expanded && "rotate-90",
          )}
        />
        <h2 className="type-h3 truncate text-foreground/80 decoration-brass decoration-2 underline-offset-4 transition-colors group-hover/row:text-foreground group-focus-visible/row:text-foreground group-focus-visible/row:underline">
          {href ? (
            <EntityLink href={href} tabIndex={-1} data-row-link>
              {title}
            </EntityLink>
          ) : (
            title
          )}
        </h2>
        {star}
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

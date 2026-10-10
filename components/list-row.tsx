"use client";

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { StatusMark } from "@/components/ui/status-dot";
import { TreeConnector } from "@/components/tree-connector";
import { EntityLink } from "@/components/entity-link";
import type { StatusMarkState } from "@/lib/ui/status-colors";
import { cn } from "@/lib/utils";

/** Indent per nesting level, in px. */
const INDENT = 22;

/**
 * One row of a comfortable list: mark, name, one signal, then the problem or a quiet value, an
 * inline fix and metrics revealed on hover or focus. Keyboard focus is managed by the list.
 */
export function ListRow({
  navKey,
  mark,
  name,
  nameTitle,
  href,
  signal,
  status,
  action,
  metrics,
  menu,
  depth = 0,
  last = true,
  dashed = false,
  expanded,
  onToggle,
  toggleLabel,
  selected = false,
  dim = false,
  flash = false,
  onOpen,
}: {
  /** Identifies the row to the list's keyboard handling. */
  navKey: string;
  mark: StatusMarkState;
  name: string;
  nameTitle?: string;
  /** The page the name links to. The rest of the row opens details. */
  href?: string;
  signal?: ReactNode;
  /** The problem, toned, or a quiet value such as uptime. */
  status?: ReactNode;
  /** An inline fix. Hidden on phones; the panel carries it there. */
  action?: ReactNode;
  /** Shown on hover, focus or selection. */
  metrics?: ReactNode;
  menu?: ReactNode;
  depth?: number;
  /** Last child under its parent: the connector stops at the elbow. */
  last?: boolean;
  dashed?: boolean;
  /** Undefined when the row has nothing nested. */
  expanded?: boolean;
  onToggle?: () => void;
  toggleLabel?: string;
  selected?: boolean;
  /** Stopped on purpose. */
  dim?: boolean;
  /** Briefly highlights a row the user jumped to. */
  flash?: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      role="treeitem"
      aria-level={depth + 2}
      aria-expanded={expanded}
      aria-selected={selected}
      aria-label={`${name}, ${mark.label}`}
      tabIndex={-1}
      data-nav={navKey}
      data-selected={selected}
      onClick={onOpen}
      className={cn(
        "group/row relative flex cursor-pointer items-center gap-(--row-gap) rounded-[10px] pr-1.5 pl-1 outline-none",
        depth > 0 ? "min-h-(--row-h-child) text-sm" : "min-h-(--row-h)",
        "hover:bg-row-hover focus-visible:bg-row-hover focus-visible:shadow-[inset_2px_0_0_var(--brass)]",
        selected && "bg-brass-muted hover:bg-brass-muted",
        flash && "animate-row-flash",
      )}
    >
      {depth === 0 ? (
        expanded === undefined ? (
          <span className="w-5 shrink-0" />
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-label={toggleLabel ?? `Show what's inside ${name}`}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.();
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground/70 hover:bg-accent hover:text-foreground"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
          </button>
        )
      ) : (
        <span
          aria-hidden="true"
          className="relative w-[22px] shrink-0 self-stretch"
          style={{ marginLeft: (depth - 1) * INDENT }}
        >
          <TreeConnector last={last} dashed={dashed} className="left-[9px] -top-1" />
        </span>
      )}

      <span className={cn("flex shrink-0", mark.pending && "motion-safe:animate-pulse")}>
        <StatusMark tone={mark.tone} pending={mark.pending} />
      </span>

      {href ? (
        <EntityLink
          href={href}
          tabIndex={-1}
          data-row-link
          title={nameTitle ? `Open ${nameTitle}` : undefined}
          className={cn("min-w-[6em] shrink truncate", depth > 0 ? "font-normal" : "font-medium", dim && "opacity-50")}
        >
          {name}
        </EntityLink>
      ) : (
        <span
          title={nameTitle}
          className={cn("min-w-[6em] shrink truncate", depth > 0 ? "font-normal" : "font-medium", dim && "opacity-50")}
        >
          {name}
        </span>
      )}
      {signal && (
        <span className={cn("min-w-0 shrink-[3] truncate text-[13px] text-muted-foreground/70 max-sm:hidden", dim && "opacity-50")}>
          {signal}
        </span>
      )}

      <span className="ml-auto flex min-w-0 shrink-[3] items-center justify-end gap-3.5 pl-2 text-[13px]">
        {metrics && (
          <span className="hidden items-center gap-3 text-muted-foreground sm:group-hover/row:inline-flex sm:group-focus-visible/row:inline-flex sm:group-data-[selected=true]/row:inline-flex">
            {metrics}
          </span>
        )}
        {status && <span className="min-w-0 truncate">{status}</span>}
        {action && (
          <span className="max-sm:hidden" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
        {menu && (
          <span
            className="opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-data-[selected=true]/row:opacity-100 has-[[aria-expanded=true]]:opacity-100 has-focus-visible:opacity-100 pointer-coarse:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            {menu}
          </span>
        )}
      </span>
    </div>
  );
}

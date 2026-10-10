"use client";

import { Fragment, type MouseEvent } from "react";
import { Tabs as TabsPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

export type SectionItem = {
  value: string;
  label: string;
  count?: number;
};

export type SectionGroup = {
  label?: string;
  items: SectionItem[];
};

/** A click that should open the link elsewhere rather than switch the tab in place. */
function opensElsewhere(e: MouseEvent) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}

/**
 * Vertical rail on lg+, horizontal scroll strip below. Renders inside a Radix Tabs root. With
 * `hrefFor`, each tab is a real link: a plain click switches in place, Cmd/Ctrl-, Shift- and
 * middle-click open it in a new browser tab.
 */
export function SectionNav({
  groups,
  label = "App sections",
  hrefFor,
}: {
  groups: SectionGroup[];
  label?: string;
  hrefFor?: (value: string) => string;
}) {
  return (
    <TabsPrimitive.List
      aria-label={label}
      className={cn(
        "flex items-center gap-1 overflow-x-auto scroll-smooth",
        // Fades the cut edges.
        "[mask-image:linear-gradient(to_right,transparent,black_1rem,black_calc(100%-1rem),transparent)]",
        "lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:[mask-image:none]",
      )}
    >
      {groups.filter((g) => g.items.length > 0).map((group, i) => (
        <Fragment key={group.label ?? i}>
          {group.label && (
            <div
              aria-hidden="true"
              className="hidden lg:block type-label text-muted-foreground/60 px-2.5 pt-5 pb-1.5 first:pt-0"
            >
              {group.label}
            </div>
          )}
          {group.items.map((item) => (
            <TabsPrimitive.Trigger
              key={item.value}
              value={item.value}
              asChild={!!hrefFor}
              // Radix switches on mousedown; a modified press leaves that to the link.
              onMouseDown={hrefFor ? (e) => opensElsewhere(e) && e.preventDefault() : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-medium",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              )}
              // Scroll the active tab into view on narrow screens.
              ref={(node) => {
                if (node?.dataset.state === "active") {
                  node.scrollIntoView({ block: "nearest", inline: "center" });
                }
              }}
            >
              {hrefFor ? (
                <a
                  href={hrefFor(item.value)}
                  onClick={(e) => {
                    if (!opensElsewhere(e)) e.preventDefault();
                  }}
                >
                  <TabLabel item={item} />
                </a>
              ) : (
                <TabLabel item={item} />
              )}
            </TabsPrimitive.Trigger>
          ))}
        </Fragment>
      ))}
    </TabsPrimitive.List>
  );
}

function TabLabel({ item }: { item: SectionItem }) {
  return (
    <>
      {item.label}
      {typeof item.count === "number" && item.count > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground lg:ml-auto">{item.count}</span>
      )}
    </>
  );
}

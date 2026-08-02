"use client";

import { Fragment } from "react";
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

/**
 * Vertical rail on lg+, horizontal scroll strip below — the same shape as the
 * settings nav. Renders inside a Radix Tabs root.
 */
export function SectionNav({ groups }: { groups: SectionGroup[] }) {
  return (
    <TabsPrimitive.List
      aria-label="App sections"
      className={cn(
        "flex items-center gap-1 overflow-x-auto scroll-smooth",
        // Fades the cut edges so a half-visible tab reads as "more this way".
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
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                "text-muted-foreground hover:text-foreground hover:bg-muted",
                "data-[state=active]:bg-primary/10 data-[state=active]:text-primary data-[state=active]:font-medium",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              )}
              // The strip is narrower than its contents on phones, so the tab
              // you are on can start off-screen with nothing to say so.
              ref={(node) => {
                if (node?.dataset.state === "active") {
                  node.scrollIntoView({ block: "nearest", inline: "center" });
                }
              }}
            >
              {item.label}
              {typeof item.count === "number" && item.count > 0 && (
                <span className="text-xs tabular-nums text-muted-foreground lg:ml-auto">
                  {item.count}
                </span>
              )}
            </TabsPrimitive.Trigger>
          ))}
        </Fragment>
      ))}
    </TabsPrimitive.List>
  );
}

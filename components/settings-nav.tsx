"use client";

import { Fragment } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isNavActive } from "@/lib/ui/nav-active";

export type SettingsNavItem = {
  label: string;
  href: string;
  /** Active only on the href itself, not on routes nested under it. */
  exact?: boolean;
};

export type SettingsNavGroup = {
  label?: string;
  items: SettingsNavItem[];
};

type SettingsNavProps = {
  items?: SettingsNavItem[];
  groups?: SettingsNavGroup[];
  label?: string;
};

/** Vertical rail on lg+, horizontal scroll strip below. */
export function SettingsNav({ items, groups, label = "Settings navigation" }: SettingsNavProps) {
  const pathname = usePathname();
  const sections = groups ?? [{ items: items ?? [] }];

  return (
    <nav
      aria-label={label}
      className={cn(
        "flex items-center gap-1 overflow-x-auto",
        "lg:flex-col lg:items-stretch lg:gap-1 lg:overflow-visible",
      )}
    >
      {sections.filter((g) => g.items.length > 0).map((group, i) => (
        <Fragment key={group.label ?? i}>
          {group.label && (
            <div
              aria-hidden="true"
              className="hidden lg:block type-label text-muted-foreground/60 px-2.5 pt-5 pb-1.5 first:pt-0"
            >
              {group.label}
            </div>
          )}
          {group.items.map((item) => {
            const isActive = item.exact ? pathname === item.href : isNavActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex shrink-0 items-center rounded-md px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors",
                  "lg:w-full",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
                aria-current={isActive ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </Fragment>
      ))}
    </nav>
  );
}

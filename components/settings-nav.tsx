"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type SettingsNavItem = {
  label: string;
  href: string;
};

type SettingsNavProps = {
  items: SettingsNavItem[];
};

/** Vertical rail on lg+, horizontal scroll strip below. */
export function SettingsNav({ items }: SettingsNavProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Settings navigation"
      className={cn(
        "flex items-center gap-1 overflow-x-auto",
        "lg:flex-col lg:items-stretch lg:gap-1 lg:overflow-visible",
      )}
    >
      {items.map((item) => {
        const isActive = pathname === item.href;
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
    </nav>
  );
}

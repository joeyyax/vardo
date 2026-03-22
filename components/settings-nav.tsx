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
  basePath: string;
};

export function SettingsNav({ items, basePath }: SettingsNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className="inline-flex w-fit items-center justify-center gap-1 text-muted-foreground"
      role="tablist"
    >
      {items.map((item) => {
        const isActive =
          pathname === item.href ||
          (pathname === basePath && item.href === items[0]?.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "relative inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all",
              "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
              "after:bg-foreground after:absolute after:inset-x-0 after:bottom-[-5px] after:h-0.5 after:opacity-0 after:transition-opacity",
              isActive && "text-foreground dark:text-foreground after:opacity-100"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
};

type SettingsNavProps = {
  items: NavItem[];
  basePath: string;
};

export function SettingsNav({ items, basePath }: SettingsNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className="inline-flex w-fit items-center justify-center gap-1 rounded-none p-[3px] text-muted-foreground"
      role="tablist"
    >
      {items.map((item) => {
        const isActive =
          pathname === item.href ||
          (item.href === `${basePath}/account` && pathname === basePath);

        return (
          <Link
            key={item.href}
            href={item.href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap transition-all",
              "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:outline-ring focus-visible:ring-[3px] focus-visible:outline-1",
              isActive
                ? "text-foreground"
                : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
              "after:bg-foreground after:absolute after:inset-x-0 after:bottom-[-5px] after:h-0.5 after:opacity-0 after:transition-opacity",
              isActive && "after:opacity-100"
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

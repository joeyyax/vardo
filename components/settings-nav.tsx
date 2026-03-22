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

export function SettingsNav({ items }: SettingsNavProps) {
  const pathname = usePathname();

  return (
    <nav
      className="flex gap-1 border-b border-border"
      aria-label="Settings navigation"
    >
      {items.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
              isActive
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/50",
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

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { entityLinkClass } from "@/components/entity-link";
import { cn } from "@/lib/utils";

/**
 * A link to another tab of the page already open. A plain click switches the tab in place;
 * Cmd/Ctrl-, Shift- and middle-click open the URL like any link.
 */
export function TabLink({
  href,
  onSwitch,
  className,
  title,
  children,
}: {
  href: string;
  onSwitch: () => void;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      title={title}
      className={cn(entityLinkClass, className)}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onSwitch();
      }}
    >
      {children}
    </Link>
  );
}

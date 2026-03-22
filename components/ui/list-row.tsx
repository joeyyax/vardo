"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface ListRowProps {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  isLast?: boolean;
}

function ListRow({ children, onClick, className, isLast }: ListRowProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group flex items-center gap-4 px-3 py-3 hover:bg-card/40 transition-colors cursor-pointer",
        !isLast && "border-b border-border/40",
        className
      )}
    >
      {children}
    </div>
  );
}

interface ListContainerProps {
  children: React.ReactNode;
  className?: string;
}

function ListContainer({ children, className }: ListContainerProps) {
  return (
    <div className={cn("bg-card/30 ring-1 ring-border/40", className)}>
      {children}
    </div>
  );
}

export { ListRow, ListContainer };
export type { ListRowProps, ListContainerProps };

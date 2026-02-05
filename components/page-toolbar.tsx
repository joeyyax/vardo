"use client";

import type { ReactNode } from "react";

type PageToolbarProps = {
  /** Filter controls (left side) */
  children: ReactNode;
  /** Action buttons, view switcher, etc. (right side) */
  actions?: ReactNode;
};

export function PageToolbar({ children, actions }: PageToolbarProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-1 flex-wrap items-center gap-2">
        {children}
      </div>
      {actions && (
        <div className="flex items-center gap-2 shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}

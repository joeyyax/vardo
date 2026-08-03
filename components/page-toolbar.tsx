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
        // Wraps rather than widening the page: two actions do not fit at 320px.
        <div className="flex flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

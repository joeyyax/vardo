"use client";

import { forwardRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { BottomSheet, BottomSheetContent, BottomSheetTitle } from "@/components/ui/bottom-sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

/** Width at which the panel floats beside the list instead of covering it. */
export const DETAIL_PANEL_QUERY = "(min-width: 1100px)";

/** Room the page leaves on its right while the floating panel is open. */
export const DETAIL_PANEL_GUTTER = "min-[1100px]:pr-[436px]";

/**
 * A record or list opened over the page it came from. On desktop it floats inset on the right and
 * leaves the page usable beside it; on phones it is a bottom sheet.
 */
export const DetailPanel = forwardRef<
  HTMLDivElement,
  {
    open: boolean;
    onClose: () => void;
    /** Names the panel for assistive tech. */
    label: string;
    /** Small text over the title, such as the project or a back link. */
    eyebrow?: ReactNode;
    title: ReactNode;
    /** Beside the close button, such as a link to the full page. */
    actions?: ReactNode;
    children: ReactNode;
  }
>(function DetailPanel({ open, onClose, label, eyebrow, title, actions, children }, ref) {
  const floating = useMediaQuery(DETAIL_PANEL_QUERY);

  const close = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close panel"
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <X className="size-4" />
    </button>
  );

  if (!floating) {
    return (
      <BottomSheet open={open} onOpenChange={(next) => !next && onClose()}>
        <BottomSheetContent aria-describedby={undefined} className="h-auto max-h-[85dvh] bg-card">
          <div ref={ref} className="grid gap-5 overflow-y-auto px-5 pt-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {eyebrow}
                <BottomSheetTitle className="type-h2 [overflow-wrap:anywhere]">{title}</BottomSheetTitle>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {actions}
                {close}
              </div>
            </div>
            {children}
          </div>
        </BottomSheetContent>
      </BottomSheet>
    );
  }

  if (!open) return null;
  return (
    <aside
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      className={cn(
        "squircle fixed top-2 right-2 bottom-2 z-40 w-[min(420px,calc(100vw-16px))] overflow-y-auto rounded-xl bg-card shadow-card-hover dark:border",
        "motion-safe:animate-in motion-safe:slide-in-from-right-8 motion-safe:fade-in-0 motion-safe:duration-200",
      )}
    >
      <div className="grid gap-5 px-5.5 pt-5 pb-7">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {eyebrow}
            <h2 className="type-h2 [overflow-wrap:anywhere]">{title}</h2>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            {close}
          </div>
        </div>
        {children}
      </div>
    </aside>
  );
});

/** A titled block inside the panel. */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-[13px] font-semibold text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

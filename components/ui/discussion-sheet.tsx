"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";

type DiscussionSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: React.ReactNode;
};

function DiscussionSheet({
  open,
  onOpenChange,
  title,
  children,
}: DiscussionSheetProps) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  return (
    <SheetPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <SheetPrimitive.Portal>
        <SheetPrimitive.Overlay
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50"
        />
        <SheetPrimitive.Content
          className={cn(
            "bg-background fixed z-50 flex flex-col shadow-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:duration-300 data-[state=open]:duration-500",
            "transition ease-in-out",
            isDesktop
              ? "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right inset-y-0 right-0 h-full w-96 border-l"
              : "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom inset-x-0 bottom-0 max-h-[85dvh] squircle rounded-t-3xl"
          )}
        >
          {/* Mobile drag indicator */}
          {!isDesktop && (
            <div className="flex justify-center pt-3 pb-0 shrink-0">
              <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
            </div>
          )}

          {/* Header with title */}
          {title && (
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0">
              <SheetPrimitive.Title className="text-sm font-semibold">
                {title}
              </SheetPrimitive.Title>
              <SheetPrimitive.Close className="rounded-xs opacity-70 transition-opacity hover:opacity-100">
                <span className="sr-only">Close</span>
              </SheetPrimitive.Close>
            </div>
          )}

          {/* Visually hidden title for accessibility when no visible title */}
          {!title && (
            <SheetPrimitive.Title className="sr-only">
              Discussion
            </SheetPrimitive.Title>
          )}

          {/* Content */}
          <div className="flex-1 overflow-y-auto min-h-0">
            {children}
          </div>
        </SheetPrimitive.Content>
      </SheetPrimitive.Portal>
    </SheetPrimitive.Root>
  );
}

export { DiscussionSheet };
export type { DiscussionSheetProps };

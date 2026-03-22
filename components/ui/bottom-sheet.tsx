"use client";

import * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

type BottomSheetSize = "default" | "lg" | "full";

const sizeClasses: Record<BottomSheetSize, string> = {
  default: "h-[85dvh]",
  lg: "h-[85dvh]",
  full: "h-[95dvh]",
};

function BottomSheet({
  open,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) {
  React.useEffect(() => {
    document.documentElement.toggleAttribute("data-bottom-sheet-open", !!open);
    return () => {
      document.documentElement.removeAttribute("data-bottom-sheet-open");
    };
  }, [open]);

  return <SheetPrimitive.Root data-slot="bottom-sheet" open={open} {...props} />;
}

const DISMISS_THRESHOLD = 100;

function BottomSheetContent({
  className,
  children,
  size = "default",
  showCloseButton = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  size?: BottomSheetSize;
  showCloseButton?: boolean;
}) {
  const contentRef = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);
  const startY = React.useRef(0);
  const currentY = React.useRef(0);

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    currentY.current = 0;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = React.useCallback((e: React.PointerEvent) => {
    if (!dragging.current || !contentRef.current) return;
    const delta = Math.max(0, e.clientY - startY.current);
    currentY.current = delta;
    contentRef.current.style.transform = `translateY(${delta}px)`;
  }, []);

  const onPointerUp = React.useCallback(() => {
    if (!dragging.current || !contentRef.current) return;
    dragging.current = false;

    if (currentY.current > DISMISS_THRESHOLD) {
      // Dismiss — find and click the close mechanism
      const closeEvent = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
      });
      contentRef.current.dispatchEvent(closeEvent);
    } else {
      // Snap back
      contentRef.current.style.transition = "transform 200ms ease-out";
      contentRef.current.style.transform = "";
      const el = contentRef.current;
      const cleanup = () => {
        el.style.transition = "";
        el.removeEventListener("transitionend", cleanup);
      };
      el.addEventListener("transitionend", cleanup);
    }
    currentY.current = 0;
  }, []);

  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay
        className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50"
      />
      <SheetPrimitive.Content
        ref={contentRef}
        data-slot="bottom-sheet-content"
        className={cn(
          "bg-background squircle rounded-t-3xl fixed bottom-0 left-1/2 -translate-x-1/2 z-50 flex w-full container flex-col shadow-lg",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
          "data-[state=closed]:duration-300 data-[state=open]:duration-500",
          sizeClasses[size],
          className
        )}
        {...props}
      >
        {/* Drag handle */}
        <div
          className="flex justify-center pt-3 pb-0 shrink-0 cursor-grab active:cursor-grabbing touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
        </div>
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function BottomSheetHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-header"
      className={cn("flex flex-col gap-1.5 px-6 py-4", className)}
      {...props}
    />
  );
}

function BottomSheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="bottom-sheet-title"
      className={cn("text-foreground font-semibold", className)}
      {...props}
    />
  );
}

function BottomSheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="bottom-sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

function BottomSheetFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="bottom-sheet-footer"
      className={cn(
        "mt-auto flex flex-col-reverse gap-2 px-6 py-4 border-t sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

function BottomSheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="bottom-sheet-close" {...props} />;
}

export {
  BottomSheet,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetClose,
};
export type { BottomSheetSize };

"use client";

import * as React from "react";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { IconButton } from "@/components/ui/icon-button";
import { X } from "lucide-react";

type DetailModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Action buttons rendered in the header (edit, archive, delete, etc.) */
  actions?: React.ReactNode;
  /** Main content area (left panel, 2/3 width) */
  children: React.ReactNode;
  /** Sidebar content (right panel, 1/3 width). Omit to use full width. */
  sidebar?: React.ReactNode;
};

function DetailModal({
  open,
  onOpenChange,
  title,
  description,
  actions,
  children,
  sidebar,
}: DetailModalProps) {
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent
        size="full"
        className="p-0 gap-0 overflow-hidden flex flex-col"
        showCloseButton={false}
      >
        {/* Sticky header */}
        <div className="sticky top-0 z-10 bg-muted/30 border-b px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1.5">
              <BottomSheetTitle className="text-lg">{title}</BottomSheetTitle>
              {description && (
                <BottomSheetDescription>{description}</BottomSheetDescription>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {actions}
              <IconButton
                icon={X}
                tooltip="Close"
                onClick={() => onOpenChange(false)}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col lg:flex-row h-full min-h-0 flex-1">
          {/* Left panel */}
          <div className={sidebar ? "flex-[2] overflow-y-auto p-6" : "flex-1 overflow-y-auto p-6"}>
            {children}
          </div>

          {/* Right panel (sidebar) */}
          {sidebar && (
            <div className="flex-1 overflow-y-auto p-6 border-t lg:border-t-0 lg:border-l bg-muted/40">
              {sidebar}
            </div>
          )}
        </div>
      </BottomSheetContent>
    </BottomSheet>
  );
}

export { DetailModal };
export type { DetailModalProps };

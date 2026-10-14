"use client";

import { type ComponentProps, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

type ConfirmDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  onConfirm: () => void;
  loading?: boolean;
  confirmLabel?: string;
  loadingLabel?: string;
  variant?: "destructive" | "default";
  /** Optional content rendered between the description and footer (e.g. a checkbox). */
  children?: ReactNode;
  /** When true the confirm button is disabled regardless of loading state. */
  confirmDisabled?: boolean;
  /** Overrides where focus lands on close. */
  onCloseAutoFocus?: ComponentProps<typeof AlertDialogContent>["onCloseAutoFocus"];
};

function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  loading = false,
  confirmLabel = "Delete",
  loadingLabel = "Deleting...",
  variant = "destructive",
  children,
  confirmDisabled = false,
  onCloseAutoFocus,
}: ConfirmDeleteDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children && <div className="px-0 pb-2">{children}</div>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>
            Cancel
          </AlertDialogCancel>
          <Button
            type="button"
            variant={variant}
            onClick={onConfirm}
            disabled={loading || confirmDisabled}
          >
            {loading ? loadingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export { ConfirmDeleteDialog };
export type { ConfirmDeleteDialogProps };

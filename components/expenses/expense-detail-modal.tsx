"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpenseDetailView } from "./expense-detail-view";
import { ExpenseDetailEdit } from "./expense-detail-edit";
import { ExpenseComments } from "./expense-comments";
import type { Expense } from "./types";

type ExpenseDetailModalProps = {
  orgId: string;
  currentUserId: string;
  expense: Expense | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
};

export function ExpenseDetailModal({
  orgId,
  currentUserId,
  expense,
  open,
  onOpenChange,
  onUpdate,
}: ExpenseDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);

  const handleClose = useCallback(
    (open: boolean) => {
      if (!open) {
        setIsEditing(false);
      }
      onOpenChange(open);
    },
    [onOpenChange]
  );

  const handleSave = useCallback(() => {
    setIsEditing(false);
    onUpdate();
  }, [onUpdate]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  if (!expense) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="squircle max-w-3xl max-h-[85vh] overflow-hidden p-0">
        <div className="flex h-full">
          {/* Left panel: Details (2/3 width) */}
          <div className="flex-[2] border-r overflow-y-auto p-6">
            <DialogHeader className="mb-4">
              <DialogTitle className="text-lg">Expense Details</DialogTitle>
            </DialogHeader>

            {isEditing ? (
              <ExpenseDetailEdit
                orgId={orgId}
                expense={expense}
                onSave={handleSave}
                onCancel={handleCancel}
              />
            ) : (
              <ExpenseDetailView
                expense={expense}
                onEdit={() => setIsEditing(true)}
              />
            )}
          </div>

          {/* Right panel: Comments (1/3 width) */}
          <div className="flex-1 flex flex-col overflow-hidden p-6">
            <h3 className="text-sm font-medium mb-4">Comments</h3>
            <div className="flex-1 overflow-y-auto">
              <ExpenseComments
                orgId={orgId}
                expenseId={expense.id}
                currentUserId={currentUserId}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

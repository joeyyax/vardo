"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExpenseDetailView } from "./expense-detail-view";
import { ExpenseDetailEdit } from "./expense-detail-edit";
import { ExpenseComments } from "./expense-comments";
import { eventBus } from "@/lib/events";
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
  expense: initialExpense,
  open,
  onOpenChange,
  onUpdate,
}: ExpenseDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [expense, setExpense] = useState<Expense | null>(initialExpense);

  // Sync with prop when a new expense is opened
  useEffect(() => {
    setExpense(initialExpense);
  }, [initialExpense]);

  // Refetch expense when it's updated
  const refetchExpense = useCallback(async () => {
    if (!expense) return;
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/expenses/${expense.id}`
      );
      if (res.ok) {
        setExpense(await res.json());
      }
    } catch (err) {
      console.error("Error refetching expense:", err);
    }
  }, [orgId, expense?.id]);

  useEffect(() => {
    if (!open || !expense) return;
    const unsub = eventBus.on("expense:updated", (e) => {
      if (e.expenseId === expense.id) refetchExpense();
    });
    return unsub;
  }, [open, expense?.id, refetchExpense]);

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
      <DialogContent size="full" className="squircle p-0 overflow-hidden">
        <div className="flex h-full min-h-0">
          {/* Left panel: Details (2/3 width) */}
          <div className="flex-[2] overflow-y-auto p-6">
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

          {/* Right panel: Discussion */}
          <div className="flex-1 overflow-hidden p-6 border-l bg-muted/40">
            <ExpenseComments
              orgId={orgId}
              expenseId={expense.id}
              currentUserId={currentUserId}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

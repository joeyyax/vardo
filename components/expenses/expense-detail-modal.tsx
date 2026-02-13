"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { Pencil, Save, X } from "lucide-react";
import { ExpenseDetailView } from "./expense-detail-view";
import { ExpenseDetailEdit } from "./expense-detail-edit";
import { ExpenseComments } from "./expense-comments";
import { WatchButton } from "@/components/watch-button";
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

  useEffect(() => {
    setExpense(initialExpense);
  }, [initialExpense]);

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
      if (!open) setIsEditing(false);
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

  const actions = isEditing ? (
    <>
      <IconButton icon={X} tooltip="Cancel" onClick={handleCancel} />
      <Button
        type="submit"
        form="expense-edit-form"
        variant="ghost"
        size="icon"
        className="size-8"
      >
        <Save className="size-4" />
      </Button>
    </>
  ) : (
    <>
      <WatchButton entityType="expense" entityId={expense.id} orgId={orgId} />
      <IconButton
        icon={Pencil}
        tooltip="Edit"
        onClick={() => setIsEditing(true)}
      />
    </>
  );

  return (
    <DetailModal
      open={open}
      onOpenChange={handleClose}
      title="Expense Details"
      actions={actions}
      sidebar={
        <ExpenseComments
          orgId={orgId}
          expenseId={expense.id}
          currentUserId={currentUserId}
        />
      }
    >
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
    </DetailModal>
  );
}

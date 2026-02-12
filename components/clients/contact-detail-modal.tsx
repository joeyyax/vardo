"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Pencil, Save, Trash2, X } from "lucide-react";
import { ContactDetailView } from "./contact-detail-view";
import { ContactDetailEdit } from "./contact-detail-edit";
import { ContactComments } from "./contact-comments";
import { toast } from "sonner";
import type { ClientContact } from "./client-dialog";

type ContactDetailModalProps = {
  orgId: string;
  clientId: string;
  currentUserId: string;
  contact: ClientContact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdate: () => void;
};

export function ContactDetailModal({
  orgId,
  clientId,
  currentUserId,
  contact,
  open,
  onOpenChange,
  onUpdate,
}: ContactDetailModalProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const baseUrl = `/api/v1/organizations/${orgId}/clients/${clientId}/contacts`;

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

  const handleDelete = useCallback(async () => {
    if (!contact) return;
    try {
      const res = await fetch(`${baseUrl}/${contact.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete contact");
      toast.success("Contact deleted");
      onOpenChange(false);
      onUpdate();
    } catch {
      toast.error("Failed to delete contact");
    }
  }, [contact, baseUrl, onOpenChange, onUpdate]);

  if (!contact) return null;

  const actions = isEditing ? (
    <>
      <IconButton icon={X} tooltip="Cancel" onClick={handleCancel} />
      <Button
        type="submit"
        form="contact-edit-form"
        variant="ghost"
        size="icon"
        className="size-8"
      >
        <Save className="size-4" />
      </Button>
    </>
  ) : (
    <>
      <IconButton
        icon={Pencil}
        tooltip="Edit"
        onClick={() => setIsEditing(true)}
      />
      <IconButton
        icon={Trash2}
        tooltip="Delete"
        onClick={() => setShowDeleteConfirm(true)}
      />
    </>
  );

  return (
    <>
      <DetailModal
        open={open}
        onOpenChange={handleClose}
        title={contact.name}
        actions={actions}
        sidebar={
          <ContactComments
            orgId={orgId}
            clientId={clientId}
            contactId={contact.id}
            currentUserId={currentUserId}
          />
        }
      >
        {isEditing ? (
          <ContactDetailEdit
            contact={contact}
            baseUrl={baseUrl}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        ) : (
          <ContactDetailView contact={contact} />
        )}
      </DetailModal>

      <ConfirmDeleteDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete contact?"
        description="This will permanently delete this contact and all associated comments."
        onConfirm={handleDelete}
      />
    </>
  );
}

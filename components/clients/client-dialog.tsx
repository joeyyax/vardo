"use client";

import { useState, useEffect } from "react";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Pencil, Trash2 } from "lucide-react";
import { ClientDetailView } from "./client-detail-view";
import { ClientDetailEdit } from "./client-detail-edit";
import { ClientComments } from "./client-comments";

export type Client = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  contactEmail: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  parentClientId: string | null;
  billingType: string | null;
  billingFrequency: string | null;
  autoGenerateInvoices: boolean | null;
  retainerAmount: number | null;
  includedMinutes: number | null;
  overageRate: number | null;
  billingDayOfWeek: number | null;
  billingDayOfMonth: number | null;
  paymentTermsDays: number | null;
  lastInvoicedDate: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClientContact = {
  id: string;
  clientId: string;
  type: "primary" | "billing" | "other";
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
};

type ClientDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  orgId: string;
  allClients?: Client[];
  onSuccess: () => void;
  currentUserId?: string;
};

export function ClientDialog({
  open,
  onOpenChange,
  client,
  orgId,
  allClients = [],
  onSuccess,
  currentUserId,
}: ClientDialogProps) {
  const [isEditing, setIsEditing] = useState(!client);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [clientData, setClientData] = useState<Client | null>(client || null);

  // Reset state when dialog opens/closes or client changes
  useEffect(() => {
    if (open) {
      setClientData(client || null);
      setIsEditing(!client); // New clients start in edit mode, existing in view mode
    }
  }, [open, client]);

  const handleSave = () => {
    setIsEditing(false);
    onSuccess();
  };

  const handleCancel = () => {
    if (clientData) {
      setIsEditing(false);
    } else {
      onOpenChange(false);
    }
  };

  const handleDelete = async () => {
    if (!clientData) return;

    setIsDeleting(true);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientData.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete client");
      }

      onSuccess();
      onOpenChange(false);
    } catch (error) {
      console.error("Error deleting client:", error);
      // Error handling could be enhanced with toast notifications
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

  const sidebar =
    clientData && currentUserId ? (
      <ClientComments
        clientId={clientData.id}
        orgId={orgId}
        currentUserId={currentUserId}
        onUpdate={onSuccess}
      />
    ) : undefined;

  return (
    <>
      <DetailModal
        open={open}
        onOpenChange={onOpenChange}
        title={clientData ? clientData.name : "New Client"}
        actions={
          <>
            {clientData && !isEditing && (
              <IconButton
                icon={Pencil}
                tooltip="Edit"
                onClick={() => setIsEditing(true)}
              />
            )}
            {clientData && (
              <IconButton
                icon={Trash2}
                tooltip="Delete"
                onClick={() => setShowDeleteDialog(true)}
                className="text-destructive hover:text-destructive"
              />
            )}
          </>
        }
        sidebar={sidebar}
      >
        {isEditing ? (
          <ClientDetailEdit
            client={clientData}
            orgId={orgId}
            allClients={allClients}
            onSave={handleSave}
            onCancel={handleCancel}
          />
        ) : clientData ? (
          <ClientDetailView
            client={clientData}
            parentClient={
              clientData.parentClientId
                ? allClients.find((c) => c.id === clientData.parentClientId)
                : null
            }
            onEdit={() => setIsEditing(true)}
          />
        ) : null}
      </DetailModal>

      <ConfirmDeleteDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        title="Delete client?"
        description={`This will permanently delete "${clientData?.name}" and all associated projects and time entries. This action cannot be undone.`}
        onConfirm={handleDelete}
        loading={isDeleting}
      />
    </>
  );
}

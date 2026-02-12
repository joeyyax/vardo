"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
import { Loader2, Mail, Phone, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useSession } from "@/lib/auth/client";
import { ContactDetailModal } from "./contact-detail-modal";
import type { ClientContact } from "./client-dialog";

type ClientContactsProps = {
  orgId: string;
  clientId: string;
};

const CONTACT_TYPES = [
  { value: "primary", label: "Primary" },
  { value: "billing", label: "Billing" },
  { value: "other", label: "Other" },
];

const TYPE_BADGE_STYLES: Record<string, string> = {
  billing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  primary: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  other: "bg-muted text-muted-foreground",
};

export function ClientContacts({ orgId, clientId }: ClientContactsProps) {
  const { data: session } = useSession();
  const [contacts, setContacts] = useState<ClientContact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [selectedContact, setSelectedContact] = useState<ClientContact | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const baseUrl = `/api/v1/organizations/${orgId}/clients/${clientId}/contacts`;

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) {
        const data = await res.json();
        setContacts(data || []);
      }
    } catch (err) {
      console.error("Error fetching contacts:", err);
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  function handleAdd() {
    setSheetOpen(true);
  }

  function handleRowClick(contact: ClientContact) {
    setSelectedContact(contact);
    setDetailOpen(true);
  }

  async function handleDelete(contactId: string) {
    try {
      const res = await fetch(`${baseUrl}/${contactId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete contact");
      fetchContacts();
    } catch {
      toast.error("Failed to delete contact");
    }
  }

  function handleSheetSuccess() {
    setSheetOpen(false);
    fetchContacts();
  }

  function handleDetailUpdate() {
    fetchContacts();
  }

  return (
    <>
      <Card className="squircle">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Users className="size-5" />
            Contacts
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleAdd}
            className="squircle"
          >
            <Plus className="size-4" />
            Add
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : contacts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No contacts yet. Add one to get started.
            </p>
          ) : (
            <div className="space-y-2">
              {contacts.map((contact) => (
                <ContactRow
                  key={contact.id}
                  contact={contact}
                  onClick={() => handleRowClick(contact)}
                  onDelete={() => handleDelete(contact.id)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <ContactSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        contact={null}
        baseUrl={baseUrl}
        onSuccess={handleSheetSuccess}
      />

      {session?.user?.id && (
        <ContactDetailModal
          orgId={orgId}
          clientId={clientId}
          currentUserId={session.user.id}
          contact={selectedContact}
          open={detailOpen}
          onOpenChange={setDetailOpen}
          onUpdate={handleDetailUpdate}
        />
      )}
    </>
  );
}

// --- View row ---

function ContactRow({
  contact,
  onClick,
  onDelete,
}: {
  contact: ClientContact;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-3 p-2.5 rounded-lg border cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate">{contact.name}</span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
              TYPE_BADGE_STYLES[contact.type] || TYPE_BADGE_STYLES.other
            )}
          >
            {contact.type}
          </span>
        </div>
        {contact.title && (
          <p className="text-xs text-muted-foreground mt-0.5">
            {contact.title}
          </p>
        )}
        <div className="flex items-center gap-3 mt-1">
          {contact.email && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Mail className="size-3" />
              {contact.email}
            </span>
          )}
          {contact.phone && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Phone className="size-3" />
              {contact.phone}
            </span>
          )}
          {!contact.email && !contact.phone && (
            <span className="text-xs text-muted-foreground italic">
              No contact info
            </span>
          )}
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
      >
        <Trash2 className="size-3" />
      </Button>
    </div>
  );
}

// --- BottomSheet form for add/edit ---

function ContactSheet({
  open,
  onOpenChange,
  contact,
  baseUrl,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact: ClientContact | null;
  baseUrl: string;
  onSuccess: () => void;
}) {
  const isEditing = !!contact;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [type, setType] = useState("other");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  // Reset form when sheet opens
  useEffect(() => {
    if (open) {
      setName(contact?.name ?? "");
      setEmail(contact?.email ?? "");
      setPhone(contact?.phone ?? "");
      setTitle(contact?.title ?? "");
      setType(contact?.type ?? "other");
      setError("");
    }
  }, [open, contact]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        title: title.trim() || null,
        type,
      };

      const url = isEditing ? `${baseUrl}/${contact.id}` : baseUrl;
      const res = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Something went wrong");
      }

      toast.success(isEditing ? "Contact updated" : "Contact added");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent className="squircle">
        <form onSubmit={handleSubmit}>
          <BottomSheetHeader>
            <BottomSheetTitle>
              {isEditing ? "Edit Contact" : "Add Contact"}
            </BottomSheetTitle>
            <BottomSheetDescription>
              Contacts are for sending invoices, documents, and reports. To grant access to the portal, use Invitations.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="contact-name">Name</Label>
                  <Input
                    id="contact-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Jane Smith"
                    required
                    autoFocus
                    className="squircle"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="contact-type">Type</Label>
                  <Select value={type} onValueChange={setType}>
                    <SelectTrigger id="contact-type" className="squircle">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="squircle">
                      {CONTACT_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="contact-email">Email</Label>
                  <Input
                    id="contact-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="jane@example.com"
                    className="squircle"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="contact-phone">Phone</Label>
                  <Input
                    id="contact-phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="555-0100"
                    className="squircle"
                  />
                </div>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="contact-title">Title</Label>
                <Input
                  id="contact-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Project Manager"
                  className="squircle"
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isLoading}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isLoading || !name.trim()}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isEditing ? "Save Changes" : "Add Contact"}
            </Button>
          </BottomSheetFooter>
        </form>
      </BottomSheetContent>
    </BottomSheet>
  );
}

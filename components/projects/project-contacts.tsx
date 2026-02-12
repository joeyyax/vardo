"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ContactPicker, type ContactOption } from "@/components/contacts/contact-picker";
import { Loader2, Plus, RotateCcw, Users, X, Mail, Phone } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type Contact = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  type: "primary" | "billing" | "other";
};

type ProjectContactsProps = {
  orgId: string;
  projectId: string;
  clientId: string;
  clientName: string;
};

const TYPE_BADGE_STYLES: Record<string, string> = {
  billing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  primary: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  other: "bg-muted text-muted-foreground",
};

export function ProjectContacts({
  orgId,
  projectId,
  clientId,
  clientName,
}: ProjectContactsProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [source, setSource] = useState<"project" | "client">("client");
  const [allClientContacts, setAllClientContacts] = useState<Contact[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const fetchContacts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/contacts`
      );
      if (res.ok) {
        const data = await res.json();
        setContacts(data.contacts || []);
        setSource(data.source);
      }
    } catch (err) {
      console.error("Error fetching project contacts:", err);
    }
  }, [orgId, projectId]);

  const fetchClientContacts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/clients/${clientId}/contacts`
      );
      if (res.ok) {
        const data = await res.json();
        setAllClientContacts(data || []);
      }
    } catch (err) {
      console.error("Error fetching client contacts:", err);
    }
  }, [orgId, clientId]);

  useEffect(() => {
    Promise.all([fetchContacts(), fetchClientContacts()]).finally(() =>
      setIsLoading(false)
    );
  }, [fetchContacts, fetchClientContacts]);

  const handleAdd = async (contactId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/contacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add contact");
      }
      toast.success("Contact added");
      fetchContacts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add contact");
    }
  };

  const handleRemove = async (contactId: string) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/contacts/${contactId}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to remove contact");
      }
      toast.success("Contact removed");
      fetchContacts();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove contact"
      );
    }
  };

  const handleResetToInherited = async () => {
    // Remove all project contact overrides
    const assigned = contacts.map((c) => c.id);
    try {
      await Promise.all(
        assigned.map((id) =>
          fetch(
            `/api/v1/organizations/${orgId}/projects/${projectId}/contacts/${id}`,
            { method: "DELETE" }
          )
        )
      );
      toast.success("Reset to inherited contacts");
      fetchContacts();
    } catch {
      toast.error("Failed to reset contacts");
    }
  };

  const handleCustomize = async () => {
    // Start overriding by adding all current inherited contacts
    try {
      await Promise.all(
        contacts.map((c) =>
          fetch(
            `/api/v1/organizations/${orgId}/projects/${projectId}/contacts`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ contactId: c.id }),
            }
          )
        )
      );
      toast.success("Contacts customized for this project");
      fetchContacts();
    } catch {
      toast.error("Failed to customize contacts");
    }
  };

  // Contacts available to add (not already assigned in override mode)
  const assignedIds = new Set(contacts.map((c) => c.id));
  const availableContacts: ContactOption[] = allClientContacts
    .filter((c) => !assignedIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      type: c.type,
      title: c.title,
    }));

  if (isLoading) {
    return (
      <Card className="squircle">
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (contacts.length === 0 && allClientContacts.length === 0) {
    return null; // No contacts to show
  }

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Users className="size-5" />
          Contacts
        </CardTitle>
        <div className="flex items-center gap-2">
          {source === "client" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCustomize}
              className="squircle"
              disabled={contacts.length === 0}
            >
              Customize
            </Button>
          ) : (
            <>
              <ContactPicker
                contacts={availableContacts}
                selected={[]}
                onSelect={handleAdd}
                open={pickerOpen}
                onOpenChange={setPickerOpen}
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="squircle"
                  disabled={availableContacts.length === 0}
                >
                  <Plus className="size-4" />
                  Add
                </Button>
              </ContactPicker>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetToInherited}
                className="squircle text-muted-foreground"
              >
                <RotateCcw className="size-4" />
                Reset
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {source === "client" && (
          <p className="text-xs text-muted-foreground mb-3">
            Inherited from{" "}
            <span className="font-medium text-foreground">{clientName}</span>
          </p>
        )}
        {source === "project" && (
          <p className="text-xs text-muted-foreground mb-3">
            Project-specific contacts
          </p>
        )}

        {contacts.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No contacts configured.
          </p>
        ) : (
          <div className="space-y-2">
            {contacts.map((contact) => (
              <div
                key={contact.id}
                className="flex items-start justify-between gap-3 p-2.5 rounded-lg border"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm truncate">
                      {contact.name}
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[10px] font-medium shrink-0",
                        TYPE_BADGE_STYLES[contact.type] ||
                          TYPE_BADGE_STYLES.other
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
                {source === "project" && (
                  <button
                    type="button"
                    onClick={() => handleRemove(contact.id)}
                    className="shrink-0 p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

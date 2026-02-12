"use client";

import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import type { ClientContact } from "./client-dialog";

const CONTACT_TYPES = [
  { value: "primary", label: "Primary" },
  { value: "billing", label: "Billing" },
  { value: "other", label: "Other" },
];

type ContactDetailEditProps = {
  contact: ClientContact;
  baseUrl: string;
  onSave: () => void;
  onCancel: () => void;
};

export function ContactDetailEdit({
  contact,
  baseUrl,
  onSave,
  onCancel,
}: ContactDetailEditProps) {
  const [name, setName] = useState(contact.name);
  const [email, setEmail] = useState(contact.email ?? "");
  const [phone, setPhone] = useState(contact.phone ?? "");
  const [title, setTitle] = useState(contact.title ?? "");
  const [type, setType] = useState(contact.type);
  const [isLoading, setIsLoading] = useState(false);

  // Reset when contact changes
  useEffect(() => {
    setName(contact.name);
    setEmail(contact.email ?? "");
    setPhone(contact.phone ?? "");
    setTitle(contact.title ?? "");
    setType(contact.type);
  }, [contact]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setIsLoading(true);

    try {
      const payload = {
        name: name.trim(),
        email: email.trim() || null,
        phone: phone.trim() || null,
        title: title.trim() || null,
        type,
      };

      const res = await fetch(`${baseUrl}/${contact.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Something went wrong");
      }

      toast.success("Contact updated");
      onSave();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update contact"
      );
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <form id="contact-edit-form" onSubmit={handleSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-2">
          <Label htmlFor="edit-contact-name">Name</Label>
          <Input
            id="edit-contact-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Smith"
            required
            autoFocus
            className="squircle"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="edit-contact-type">Type</Label>
          <Select value={type} onValueChange={(v) => setType(v as ClientContact["type"])}>
            <SelectTrigger id="edit-contact-type" className="squircle">
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
          <Label htmlFor="edit-contact-email">Email</Label>
          <Input
            id="edit-contact-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="jane@example.com"
            className="squircle"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="edit-contact-phone">Phone</Label>
          <Input
            id="edit-contact-phone"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="555-0100"
            className="squircle"
          />
        </div>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="edit-contact-title">Title</Label>
        <Input
          id="edit-contact-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Project Manager"
          className="squircle"
        />
      </div>
    </form>
  );
}

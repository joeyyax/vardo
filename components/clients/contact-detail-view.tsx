"use client";

import { DetailField } from "@/components/ui/detail-field";
import { cn } from "@/lib/utils";
import { Mail, Phone } from "lucide-react";
import type { ClientContact } from "./client-dialog";

const TYPE_BADGE_STYLES: Record<string, string> = {
  billing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  primary: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  other: "bg-muted text-muted-foreground",
};

type ContactDetailViewProps = {
  contact: ClientContact;
};

export function ContactDetailView({ contact }: ContactDetailViewProps) {
  return (
    <div className="space-y-4">
      <DetailField label="Name">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {contact.name}
          </span>
          <span
            className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] font-medium",
              TYPE_BADGE_STYLES[contact.type] || TYPE_BADGE_STYLES.other
            )}
          >
            {contact.type}
          </span>
        </div>
      </DetailField>

      {contact.title && (
        <DetailField label="Title">{contact.title}</DetailField>
      )}

      {contact.email && (
        <DetailField label="Email">
          <a
            href={`mailto:${contact.email}`}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1.5"
          >
            <Mail className="size-3.5" />
            {contact.email}
          </a>
        </DetailField>
      )}

      {contact.phone && (
        <DetailField label="Phone">
          <span className="flex items-center gap-1.5">
            <Phone className="size-3.5" />
            {contact.phone}
          </span>
        </DetailField>
      )}

      {!contact.email && !contact.phone && !contact.title && (
        <p className="text-sm text-muted-foreground italic">
          No additional contact information.
        </p>
      )}
    </div>
  );
}

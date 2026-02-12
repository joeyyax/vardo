"use client";

import { cn } from "@/lib/utils";

export type SuggestableContact = {
  id: string;
  name: string;
  email: string | null;
  type: "primary" | "billing" | "other";
};

type ContactSuggestionsProps = {
  contacts: SuggestableContact[];
  onSelect: (email: string) => void;
  label?: string;
};

const TYPE_BADGE_STYLES: Record<string, string> = {
  billing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  primary: "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  other: "bg-muted text-muted-foreground",
};

/**
 * Inline contact suggestion chips for send dialogs.
 * Only shows contacts that have an email address.
 * Clicking a chip calls onSelect with the email.
 */
export function ContactSuggestions({
  contacts,
  onSelect,
  label = "Suggested contacts",
}: ContactSuggestionsProps) {
  const withEmail = contacts.filter((c) => c.email);
  if (withEmail.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {withEmail.map((contact) => (
          <button
            key={contact.id}
            type="button"
            onClick={() => onSelect(contact.email!)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
              "border hover:bg-accent/50 transition-colors cursor-pointer",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            )}
          >
            <span>{contact.name}</span>
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px]",
                TYPE_BADGE_STYLES[contact.type] || TYPE_BADGE_STYLES.other
              )}
            >
              {contact.type}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

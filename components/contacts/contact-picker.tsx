"use client";

import { useState, type ReactNode } from "react";
import { Check, User } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type ContactOption = {
  id: string;
  name: string;
  email: string | null;
  type: "primary" | "billing" | "other";
  title: string | null;
};

type ContactPickerProps = {
  contacts: ContactOption[];
  selected?: string[];
  onSelect: (contactId: string) => void;
  mode?: "single" | "multi";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Only show contacts that have an email address */
  emailOnly?: boolean;
};

const TYPE_LABELS: Record<string, string> = {
  billing: "Billing",
  primary: "Primary",
  other: "Other",
};

const TYPE_ORDER: Record<string, number> = {
  billing: 0,
  primary: 1,
  other: 2,
};

export function ContactPicker({
  contacts,
  selected = [],
  onSelect,
  mode = "single",
  open,
  onOpenChange,
  children,
  emailOnly = false,
}: ContactPickerProps) {
  const [search, setSearch] = useState("");

  const filtered = contacts
    .filter((c) => !emailOnly || c.email)
    .filter(
      (c) =>
        !search ||
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.email?.toLowerCase().includes(search.toLowerCase())
    );

  // Group by type
  const groups = new Map<string, ContactOption[]>();
  for (const c of filtered) {
    const list = groups.get(c.type) || [];
    list.push(c);
    groups.set(c.type, list);
  }

  const sortedGroups = [...groups.entries()].sort(
    ([a], [b]) => (TYPE_ORDER[a] ?? 9) - (TYPE_ORDER[b] ?? 9)
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="squircle w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search contacts..."
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No contacts found.</CommandEmpty>
            {sortedGroups.map(([type, items]) => (
              <CommandGroup key={type} heading={TYPE_LABELS[type] || type}>
                {items.map((contact) => {
                  const isSelected = selected.includes(contact.id);
                  return (
                    <CommandItem
                      key={contact.id}
                      value={contact.id}
                      onSelect={() => {
                        onSelect(contact.id);
                        if (mode === "single") onOpenChange(false);
                      }}
                    >
                      <User className="size-4 shrink-0 text-muted-foreground" />
                      <div className="flex-1 min-w-0">
                        <div className="truncate text-sm font-medium">
                          {contact.name}
                        </div>
                        {contact.email ? (
                          <div className="truncate text-xs text-muted-foreground">
                            {contact.email}
                          </div>
                        ) : (
                          <div className="text-xs text-muted-foreground italic">
                            (no email)
                          </div>
                        )}
                      </div>
                      <Check
                        className={cn(
                          "size-4 shrink-0",
                          isSelected ? "opacity-100" : "opacity-0"
                        )}
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

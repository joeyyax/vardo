"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { z } from "zod";
import { toast } from "sonner";
import type { Client, ClientContact } from "./client-dialog";

// Preset colors for client identification
const PRESET_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#3b82f6", // blue
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899", // pink
  "#64748b", // slate
];

const BILLING_TYPES = [
  {
    value: "hourly",
    label: "Hourly",
    description: "Bill for actual hours worked",
  },
  {
    value: "retainer_fixed",
    label: "Fixed Retainer",
    description: "Flat fee per billing period",
  },
  {
    value: "retainer_capped",
    label: "Capped Retainer",
    description: "Hourly up to a maximum amount",
  },
  {
    value: "retainer_uncapped",
    label: "Uncapped Retainer",
    description: "Hourly with a baseline minimum",
  },
  {
    value: "fixed_project",
    label: "Fixed Project",
    description: "One-time project fee",
  },
] as const;

const BILLING_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Bi-weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "per_project", label: "Per Project" },
] as const;

const DAYS_OF_WEEK = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
] as const;

const CONTACT_TYPES = [
  { value: "primary", label: "Primary" },
  { value: "billing", label: "Billing" },
  { value: "other", label: "Other" },
] as const;

const clientSchema = z.object({
  name: z.string().min(1, "Name is required"),
  color: z.string().nullable(),
  rateOverride: z.string(),
  isBillable: z.boolean().nullable(),
  parentClientId: z.string().nullable(),
  billingType: z.string().nullable(),
  billingFrequency: z.string().nullable(),
  autoGenerateInvoices: z.boolean(),
  retainerAmount: z.string(),
  includedHours: z.string(),
  overageRate: z.string(),
  billingDayOfWeek: z.number().nullable(),
  billingDayOfMonth: z.number().nullable(),
  paymentTermsDays: z.string(),
});

type ClientFormData = z.infer<typeof clientSchema>;

type ClientDetailEditProps = {
  client: Client | null;
  orgId: string;
  allClients: Client[];
  contacts: ClientContact[];
  onContactsChange: () => void;
  onSave: () => void;
  onCancel: () => void;
};

export function ClientDetailEdit({
  client,
  orgId,
  allClients,
  contacts,
  onContactsChange,
  onSave,
  onCancel,
}: ClientDetailEditProps) {
  const isEditing = !!client;
  const [showBillingSection, setShowBillingSection] = useState(false);

  const form = useForm<ClientFormData>({
    resolver: zodResolver(clientSchema),
    defaultValues: {
      name: "",
      color: null,
      rateOverride: "",
      isBillable: null,
      parentClientId: null,
      billingType: null,
      billingFrequency: null,
      autoGenerateInvoices: false,
      retainerAmount: "",
      includedHours: "",
      overageRate: "",
      billingDayOfWeek: null,
      billingDayOfMonth: null,
      paymentTermsDays: "",
    },
  });

  // Reset form when client changes
  useEffect(() => {
    if (client) {
      form.reset({
        name: client.name,
        color: client.color,
        rateOverride:
          client.rateOverride !== null
            ? (client.rateOverride / 100).toString()
            : "",
        isBillable: client.isBillable,
        parentClientId: client.parentClientId,
        billingType: client.billingType,
        billingFrequency: client.billingFrequency,
        autoGenerateInvoices: client.autoGenerateInvoices ?? false,
        retainerAmount:
          client.retainerAmount !== null
            ? (client.retainerAmount / 100).toString()
            : "",
        includedHours:
          client.includedMinutes !== null && client.includedMinutes !== undefined
            ? (client.includedMinutes / 60).toString()
            : "",
        overageRate:
          client.overageRate !== null && client.overageRate !== undefined
            ? (client.overageRate / 100).toString()
            : "",
        billingDayOfWeek: client.billingDayOfWeek,
        billingDayOfMonth: client.billingDayOfMonth,
        paymentTermsDays:
          client.paymentTermsDays !== null
            ? client.paymentTermsDays.toString()
            : "",
      });
      setShowBillingSection(
        client.billingType !== null ||
          client.billingFrequency !== null ||
          client.autoGenerateInvoices === true ||
          client.retainerAmount !== null
      );
    } else {
      form.reset({
        name: "",
        color: null,
        rateOverride: "",
        isBillable: null,
        parentClientId: null,
        billingType: null,
        billingFrequency: null,
        autoGenerateInvoices: false,
        retainerAmount: "",
        includedHours: "",
        overageRate: "",
        billingDayOfWeek: null,
        billingDayOfMonth: null,
        paymentTermsDays: "",
      });
      setShowBillingSection(false);
    }
  }, [client, form]);

  // Determine which clients can be parents
  const hasChildren =
    isEditing && allClients.some((c) => c.parentClientId === client?.id);
  const availableParents = allClients.filter((c) => {
    if (isEditing && c.id === client?.id) return false;
    if (c.parentClientId !== null) return false;
    return true;
  });

  async function onSubmit(data: ClientFormData) {
    try {
      const payload = {
        name: data.name,
        color: data.color,
        rateOverride: data.rateOverride ? parseFloat(data.rateOverride) : null,
        isBillable: data.isBillable,
        parentClientId: data.parentClientId,
        billingType: data.billingType,
        billingFrequency: data.billingFrequency,
        autoGenerateInvoices: data.autoGenerateInvoices,
        retainerAmount: data.retainerAmount
          ? parseFloat(data.retainerAmount)
          : null,
        includedMinutes: data.includedHours
          ? Math.round(parseFloat(data.includedHours) * 60)
          : null,
        overageRate: data.overageRate
          ? parseFloat(data.overageRate)
          : null,
        billingDayOfWeek: data.billingDayOfWeek,
        billingDayOfMonth: data.billingDayOfMonth,
        paymentTermsDays: data.paymentTermsDays
          ? parseInt(data.paymentTermsDays, 10)
          : null,
      };

      const url = isEditing
        ? `/api/v1/organizations/${orgId}/clients/${client.id}`
        : `/api/v1/organizations/${orgId}/clients`;

      const response = await fetch(url, {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const responseData = await response.json();
        throw new Error(responseData.error || "Something went wrong");
      }

      onSave();
    } catch (err) {
      console.error("Error saving client:", err);
      // Error handling could be improved with toast notifications
    }
  }

  const billingType = form.watch("billingType");
  const billingFrequency = form.watch("billingFrequency");
  const isBillable = form.watch("isBillable");

  return (
    <Form {...form}>
      <form id="client-edit-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  placeholder="Acme Corp"
                  autoFocus
                  className="squircle"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Contacts section */}
        {client && (
          <ContactsEditor
            contacts={contacts}
            clientId={client.id}
            orgId={orgId}
            onContactsChange={onContactsChange}
          />
        )}

        {availableParents.length > 0 && !hasChildren && (
          <FormField
            control={form.control}
            name="parentClientId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Parent Client</FormLabel>
                <FormDescription>
                  Optionally nest this client under another (e.g., Agency → End Client).
                </FormDescription>
                <Select
                  value={field.value || "none"}
                  onValueChange={(value) =>
                    field.onChange(value === "none" ? null : value)
                  }
                >
                  <FormControl>
                    <SelectTrigger className="squircle">
                      <SelectValue placeholder="No parent (top-level)" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent className="squircle">
                    <SelectItem value="none">No parent (top-level)</SelectItem>
                    {availableParents.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          {c.color && (
                            <span
                              className="size-3 rounded-full"
                              style={{ backgroundColor: c.color }}
                            />
                          )}
                          {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        )}

        {hasChildren && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            This client has sub-clients and cannot be moved under another parent.
          </div>
        )}

        <FormField
          control={form.control}
          name="color"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Color</FormLabel>
              <FormDescription>
                Choose a color to help identify this client.
              </FormDescription>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() =>
                      field.onChange(field.value === c ? null : c)
                    }
                    className={`size-8 rounded-full transition-all hover:scale-110 ${
                      field.value === c
                        ? "ring-2 ring-offset-2 ring-ring"
                        : "ring-1 ring-border"
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="rateOverride"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Hourly rate override</FormLabel>
              <FormDescription>
                Leave blank to inherit from organization.
              </FormDescription>
              <FormControl>
                <CurrencyInput {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="isBillable"
          render={({ field }) => (
            <FormItem className="flex items-center justify-between gap-3">
              <div className="grid gap-1">
                <FormLabel className="cursor-pointer">Billable</FormLabel>
                <FormDescription>
                  {field.value === null
                    ? "Inherits from organization settings."
                    : field.value
                      ? "Time tracked is billable."
                      : "Time tracked is not billable."}
                </FormDescription>
              </div>
              <div className="flex items-center gap-2">
                {field.value !== null && (
                  <button
                    type="button"
                    onClick={() => field.onChange(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Reset
                  </button>
                )}
                <FormControl>
                  <Switch
                    checked={field.value === true}
                    onCheckedChange={(checked) => {
                      field.onChange(checked);
                    }}
                  />
                </FormControl>
              </div>
            </FormItem>
          )}
        />

        {/* Billing configuration section */}
        <div className="border-t pt-4">
          <button
            type="button"
            onClick={() => setShowBillingSection(!showBillingSection)}
            className="flex w-full items-center justify-between text-sm font-medium hover:text-foreground"
          >
            <span>Billing Configuration</span>
            {showBillingSection ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </button>

          {showBillingSection && (
            <div className="mt-4 space-y-5">
              <FormField
                control={form.control}
                name="billingType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Billing Type</FormLabel>
                    <Select
                      value={field.value || "none"}
                      onValueChange={(value) =>
                        field.onChange(value === "none" ? null : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="squircle">
                          <SelectValue placeholder="Select billing type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="squircle">
                        <SelectItem value="none">None</SelectItem>
                        {BILLING_TYPES.map((type) => (
                          <SelectItem key={type.value} value={type.value}>
                            <div className="grid gap-0.5">
                              <div className="font-medium">{type.label}</div>
                              <div className="text-xs text-muted-foreground">
                                {type.description}
                              </div>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="billingFrequency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Billing Frequency</FormLabel>
                    <Select
                      value={field.value || "none"}
                      onValueChange={(value) =>
                        field.onChange(value === "none" ? null : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger className="squircle">
                          <SelectValue placeholder="Select frequency" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="squircle">
                        <SelectItem value="none">None</SelectItem>
                        {BILLING_FREQUENCIES.map((freq) => (
                          <SelectItem key={freq.value} value={freq.value}>
                            {freq.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {(billingType === "retainer_fixed" ||
                billingType === "retainer_capped" ||
                billingType === "retainer_uncapped") && (
                <FormField
                  control={form.control}
                  name="retainerAmount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Retainer Amount</FormLabel>
                      <FormDescription>
                        {billingType === "retainer_fixed" &&
                          "Flat monthly fee."}
                        {billingType === "retainer_capped" &&
                          "Maximum monthly charge."}
                        {billingType === "retainer_uncapped" &&
                          "Minimum monthly charge."}
                      </FormDescription>
                      <FormControl>
                        <CurrencyInput {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {(billingType === "retainer_fixed" ||
                billingType === "retainer_capped" ||
                billingType === "retainer_uncapped") && (
                <FormField
                  control={form.control}
                  name="includedHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Included Hours</FormLabel>
                      <FormDescription>
                        Hours included per billing period. Tracks usage against this amount.
                      </FormDescription>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="0"
                          step="0.5"
                          placeholder="20"
                          className="squircle"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {billingType === "retainer_capped" && (
                <FormField
                  control={form.control}
                  name="overageRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Overage Rate</FormLabel>
                      <FormDescription>
                        Hourly rate for hours beyond the included amount.
                      </FormDescription>
                      <FormControl>
                        <CurrencyInput {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {(billingFrequency === "weekly" ||
                billingFrequency === "biweekly") && (
                <FormField
                  control={form.control}
                  name="billingDayOfWeek"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Billing Day (Weekly)</FormLabel>
                      <Select
                        value={field.value?.toString() || "none"}
                        onValueChange={(value) =>
                          field.onChange(
                            value === "none" ? null : parseInt(value, 10)
                          )
                        }
                      >
                        <FormControl>
                          <SelectTrigger className="squircle">
                            <SelectValue placeholder="Select day" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="squircle">
                          <SelectItem value="none">None</SelectItem>
                          {DAYS_OF_WEEK.map((day) => (
                            <SelectItem
                              key={day.value}
                              value={day.value.toString()}
                            >
                              {day.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              {(billingFrequency === "monthly" ||
                billingFrequency === "quarterly") && (
                <FormField
                  control={form.control}
                  name="billingDayOfMonth"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Billing Day (Monthly)</FormLabel>
                      <FormDescription>
                        Day of the month to generate invoices (1-31).
                      </FormDescription>
                      <FormControl>
                        <Input
                          type="number"
                          min="1"
                          max="31"
                          placeholder="1"
                          value={field.value ?? ""}
                          onChange={(e) =>
                            field.onChange(
                              e.target.value
                                ? parseInt(e.target.value, 10)
                                : null
                            )
                          }
                          className="squircle"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <FormField
                control={form.control}
                name="paymentTermsDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Payment Terms</FormLabel>
                    <FormDescription>
                      Number of days until payment is due (e.g., Net 30).
                    </FormDescription>
                    <FormControl>
                      <Input
                        {...field}
                        type="number"
                        min="0"
                        placeholder="30"
                        className="squircle"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="autoGenerateInvoices"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel className="cursor-pointer">
                        Auto-generate invoices
                      </FormLabel>
                      <FormDescription>
                        Automatically create invoices based on billing frequency.
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            </div>
          )}
        </div>
      </form>
    </Form>
  );
}

// --- Contacts editor sub-component ---

type ContactsEditorProps = {
  contacts: ClientContact[];
  clientId: string;
  orgId: string;
  onContactsChange: () => void;
};

function ContactsEditor({ contacts, clientId, orgId, onContactsChange }: ContactsEditorProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const baseUrl = `/api/v1/organizations/${orgId}/clients/${clientId}/contacts`;

  async function handleAdd() {
    setAdding(true);
    try {
      const res = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "New Contact", type: "other" }),
      });
      if (!res.ok) throw new Error("Failed to create contact");
      onContactsChange();
      const created = await res.json();
      setEditingId(created.id);
    } catch {
      toast.error("Failed to add contact");
    } finally {
      setAdding(false);
    }
  }

  async function handleUpdate(contactId: string, field: string, value: string) {
    try {
      const res = await fetch(`${baseUrl}/${contactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) throw new Error("Failed to update contact");
      onContactsChange();
    } catch {
      toast.error("Failed to update contact");
    }
  }

  async function handleDelete(contactId: string) {
    try {
      const res = await fetch(`${baseUrl}/${contactId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete contact");
      onContactsChange();
    } catch {
      toast.error("Failed to delete contact");
    }
  }

  return (
    <div className="border-t pt-4 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Contacts</h4>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleAdd}
          disabled={adding}
          className="h-7 gap-1 text-xs"
        >
          <Plus className="size-3" />
          Add contact
        </Button>
      </div>

      {contacts.length === 0 && (
        <p className="text-sm text-muted-foreground italic">No contacts yet. Add one above.</p>
      )}

      {contacts.map((contact) => (
        <ContactRow
          key={contact.id}
          contact={contact}
          isEditing={editingId === contact.id}
          onStartEdit={() => setEditingId(contact.id)}
          onStopEdit={() => setEditingId(null)}
          onUpdate={(field, value) => handleUpdate(contact.id, field, value)}
          onDelete={() => handleDelete(contact.id)}
        />
      ))}
    </div>
  );
}

type ContactRowProps = {
  contact: ClientContact;
  isEditing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onUpdate: (field: string, value: string) => void;
  onDelete: () => void;
};

function ContactRow({ contact, isEditing, onStartEdit, onStopEdit, onUpdate, onDelete }: ContactRowProps) {
  if (!isEditing) {
    return (
      <div
        className="flex items-center gap-2 rounded-md border p-2 cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={onStartEdit}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{contact.name}</span>
            <span className="text-[10px] text-muted-foreground capitalize">{contact.type}</span>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {contact.email && <span>{contact.email}</span>}
            {contact.phone && <span>{contact.phone}</span>}
            {contact.title && <span>{contact.title}</span>}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    );
  }

  return (
    <div className="rounded-md border p-3 space-y-2 bg-muted/30">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Name *</label>
          <Input
            defaultValue={contact.name}
            onBlur={(e) => {
              if (e.target.value.trim() && e.target.value !== contact.name) {
                onUpdate("name", e.target.value.trim());
              }
            }}
            className="squircle h-8 text-sm"
            autoFocus
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Type</label>
          <Select
            defaultValue={contact.type}
            onValueChange={(value) => onUpdate("type", value)}
          >
            <SelectTrigger className="squircle h-8 text-sm">
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
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Email</label>
          <Input
            defaultValue={contact.email ?? ""}
            type="email"
            placeholder="email@example.com"
            onBlur={(e) => {
              if (e.target.value !== (contact.email ?? "")) {
                onUpdate("email", e.target.value);
              }
            }}
            className="squircle h-8 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Phone</label>
          <Input
            defaultValue={contact.phone ?? ""}
            placeholder="555-0100"
            onBlur={(e) => {
              if (e.target.value !== (contact.phone ?? "")) {
                onUpdate("phone", e.target.value);
              }
            }}
            className="squircle h-8 text-sm"
          />
        </div>
      </div>
      <div>
        <label className="text-xs text-muted-foreground">Title</label>
        <Input
          defaultValue={contact.title ?? ""}
          placeholder="e.g. Project Manager"
          onBlur={(e) => {
            if (e.target.value !== (contact.title ?? "")) {
              onUpdate("title", e.target.value);
            }
          }}
          className="squircle h-8 text-sm"
        />
      </div>
      <div className="flex justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="h-7 text-xs text-destructive hover:text-destructive"
        >
          <Trash2 className="size-3 mr-1" />
          Remove
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onStopEdit}
          className="h-7 text-xs"
        >
          Done
        </Button>
      </div>
    </div>
  );
}

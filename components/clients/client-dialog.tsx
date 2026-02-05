"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";
import { z } from "zod";

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

export type Client = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  parentClientId: string | null;
  billingType: string | null;
  billingFrequency: string | null;
  autoGenerateInvoices: boolean | null;
  retainerAmount: number | null;
  billingDayOfWeek: number | null;
  billingDayOfMonth: number | null;
  paymentTermsDays: number | null;
  lastInvoicedDate: string | null;
  createdAt: string;
  updatedAt: string;
};

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
  billingDayOfWeek: z.number().nullable(),
  billingDayOfMonth: z.number().nullable(),
  paymentTermsDays: z.string(),
});

type ClientFormData = z.infer<typeof clientSchema>;

type ClientDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  orgId: string;
  allClients?: Client[];
  onSuccess: () => void;
};

export function ClientDialog({
  open,
  onOpenChange,
  client,
  orgId,
  allClients = [],
  onSuccess,
}: ClientDialogProps) {
  const isEditing = !!client;

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
      billingDayOfWeek: null,
      billingDayOfMonth: null,
      paymentTermsDays: "",
    },
  });

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBillingSection, setShowBillingSection] = useState(false);

  // Reset form when dialog opens/closes or client changes
  useEffect(() => {
    if (open) {
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
          billingDayOfWeek: null,
          billingDayOfMonth: null,
          paymentTermsDays: "",
        });
        setShowBillingSection(false);
      }
      setError(null);
    }
  }, [open, client, form]);

  // Determine which clients can be parents
  const hasChildren =
    isEditing && allClients.some((c) => c.parentClientId === client?.id);
  const availableParents = allClients.filter((c) => {
    if (isEditing && c.id === client?.id) return false;
    if (c.parentClientId !== null) return false;
    return true;
  });

  async function onSubmit(data: ClientFormData) {
    setError(null);
    setIsLoading(true);

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

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  const handleDelete = async () => {
    if (!client) return;

    setIsDeleting(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/clients/${client.id}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsDeleting(false);
    }
  };

  const billingType = form.watch("billingType");
  const billingFrequency = form.watch("billingFrequency");
  const isBillable = form.watch("isBillable");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)}>
            <DialogHeader>
              <DialogTitle>
                {isEditing ? "Edit client" : "New client"}
              </DialogTitle>
              <DialogDescription>
                {isEditing
                  ? "Update your client's details."
                  : "Add a new client to your organization."}
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-5 py-6">
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

              {availableParents.length > 0 && !hasChildren && (
                <FormField
                  control={form.control}
                  name="parentClientId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Parent Client</FormLabel>
                      <FormDescription>
                        Optionally nest this client under another (e.g., Agency
                        → End Client).
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
                          <SelectItem value="none">
                            No parent (top-level)
                          </SelectItem>
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
                  This client has sub-clients and cannot be moved under another
                  parent.
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
                      Leave blank to use your organization&apos;s default rate.
                    </FormDescription>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                        $
                      </span>
                      <FormControl>
                        <Input
                          {...field}
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          className="squircle pl-7"
                        />
                      </FormControl>
                    </div>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="isBillable"
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value === true}
                        onCheckedChange={(checked) => {
                          if (checked === "indeterminate") return;
                          if (checked) {
                            field.onChange(true);
                          } else if (field.value === true) {
                            field.onChange(false);
                          } else {
                            field.onChange(null);
                          }
                        }}
                        className="mt-0.5"
                      />
                    </FormControl>
                    <div className="grid gap-1">
                      <FormLabel className="cursor-pointer">Billable</FormLabel>
                      <FormDescription>
                        {field.value === null
                          ? "Inherits from organization settings."
                          : field.value
                            ? "Time tracked for this client is billable."
                            : "Time tracked for this client is not billable."}
                      </FormDescription>
                    </div>
                  </FormItem>
                )}
              />

              {/* Billing Configuration Section (collapsible) */}
              <div className="border-t pt-4">
                <button
                  type="button"
                  onClick={() => setShowBillingSection(!showBillingSection)}
                  className="flex w-full items-center justify-between text-sm font-medium hover:text-foreground/80"
                >
                  <span>Billing Configuration</span>
                  {showBillingSection ? (
                    <ChevronUp className="size-4" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                </button>

                {showBillingSection && (
                  <div className="mt-4 grid gap-4">
                    <FormField
                      control={form.control}
                      name="billingType"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Billing Type</FormLabel>
                          <Select
                            value={field.value || ""}
                            onValueChange={(value) =>
                              field.onChange(value || null)
                            }
                          >
                            <FormControl>
                              <SelectTrigger className="squircle">
                                <SelectValue placeholder="Select billing type..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="squircle">
                              {BILLING_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  <div className="flex flex-col">
                                    <span>{type.label}</span>
                                    <span className="text-xs text-muted-foreground">
                                      {type.description}
                                    </span>
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {billingType && billingType.includes("retainer") && (
                      <FormField
                        control={form.control}
                        name="retainerAmount"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {billingType === "retainer_fixed"
                                ? "Fixed Retainer Amount"
                                : billingType === "retainer_capped"
                                  ? "Maximum Amount (Cap)"
                                  : "Minimum Retainer Amount"}
                            </FormLabel>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                                $
                              </span>
                              <FormControl>
                                <Input
                                  {...field}
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  placeholder="0.00"
                                  className="squircle pl-7"
                                />
                              </FormControl>
                            </div>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    )}

                    <FormField
                      control={form.control}
                      name="billingFrequency"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Billing Frequency</FormLabel>
                          <Select
                            value={field.value || ""}
                            onValueChange={(value) =>
                              field.onChange(value || null)
                            }
                          >
                            <FormControl>
                              <SelectTrigger className="squircle">
                                <SelectValue placeholder="Select frequency..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent className="squircle">
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

                    {(billingFrequency === "weekly" ||
                      billingFrequency === "biweekly") && (
                      <FormField
                        control={form.control}
                        name="billingDayOfWeek"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Billing Day</FormLabel>
                            <Select
                              value={field.value?.toString() || ""}
                              onValueChange={(value) =>
                                field.onChange(
                                  value ? parseInt(value, 10) : null
                                )
                              }
                            >
                              <FormControl>
                                <SelectTrigger className="squircle">
                                  <SelectValue placeholder="Select day..." />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent className="squircle">
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
                            <FormLabel>Billing Day of Month</FormLabel>
                            <FormControl>
                              <Input
                                type="number"
                                min="1"
                                max="31"
                                value={field.value?.toString() || ""}
                                onChange={(e) =>
                                  field.onChange(
                                    e.target.value
                                      ? parseInt(e.target.value, 10)
                                      : null
                                  )
                                }
                                placeholder="1-31"
                                className="squircle"
                              />
                            </FormControl>
                            <FormDescription>
                              For months with fewer days, billing will occur on
                              the last day.
                            </FormDescription>
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
                          <FormLabel>Payment Terms (Net Days)</FormLabel>
                          <FormControl>
                            <Input
                              {...field}
                              type="number"
                              min="0"
                              max="365"
                              placeholder="30"
                              className="squircle"
                            />
                          </FormControl>
                          <FormDescription>
                            Leave blank to use organization default.
                          </FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {billingFrequency && billingFrequency !== "per_project" && (
                      <FormField
                        control={form.control}
                        name="autoGenerateInvoices"
                        render={({ field }) => (
                          <FormItem className="flex items-center justify-between">
                            <div className="grid gap-1">
                              <FormLabel>Auto-generate Invoices</FormLabel>
                              <FormDescription>
                                Automatically create invoices on the billing
                                schedule.
                              </FormDescription>
                            </div>
                            <FormControl>
                              <Switch
                                checked={field.value}
                                onCheckedChange={field.onChange}
                              />
                            </FormControl>
                          </FormItem>
                        )}
                      />
                    )}
                  </div>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>

            <DialogFooter className="gap-2 sm:gap-0">
              {isEditing && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isLoading || isDeleting}
                      className="squircle mr-auto"
                    >
                      {isDeleting && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent className="squircle">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete client?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will permanently delete &quot;{client?.name}&quot;
                        and all associated projects and time entries. This
                        action cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel className="squircle">
                        Cancel
                      </AlertDialogCancel>
                      <AlertDialogAction
                        onClick={handleDelete}
                        className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isLoading || isDeleting}
                className="squircle"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={isLoading || isDeleting}
                className="squircle"
              >
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                {isEditing ? "Save changes" : "Create client"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

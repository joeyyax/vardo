"use client";

import { useState, useEffect } from "react";
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
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Loader2, ChevronDown, ChevronUp } from "lucide-react";

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
  // Parent client for hierarchy
  parentClientId: string | null;
  // Billing configuration
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
  { value: "hourly", label: "Hourly", description: "Bill for actual hours worked" },
  { value: "retainer_fixed", label: "Fixed Retainer", description: "Flat fee per billing period" },
  { value: "retainer_capped", label: "Capped Retainer", description: "Hourly up to a maximum amount" },
  { value: "retainer_uncapped", label: "Uncapped Retainer", description: "Hourly with a baseline minimum" },
  { value: "fixed_project", label: "Fixed Project", description: "One-time project fee" },
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

type ClientDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client?: Client | null;
  orgId: string;
  allClients?: Client[]; // For parent selection
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

  // Form state
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [rateOverride, setRateOverride] = useState("");
  const [isBillable, setIsBillable] = useState<boolean | null>(null);
  const [parentClientId, setParentClientId] = useState<string | null>(null);

  // Billing configuration state
  const [billingType, setBillingType] = useState<string | null>(null);
  const [billingFrequency, setBillingFrequency] = useState<string | null>(null);
  const [autoGenerateInvoices, setAutoGenerateInvoices] = useState(false);
  const [retainerAmount, setRetainerAmount] = useState("");
  const [billingDayOfWeek, setBillingDayOfWeek] = useState<number | null>(null);
  const [billingDayOfMonth, setBillingDayOfMonth] = useState<number | null>(null);
  const [paymentTermsDays, setPaymentTermsDays] = useState("");

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBillingSection, setShowBillingSection] = useState(false);

  // Reset form when dialog opens/closes or client changes
  useEffect(() => {
    if (open) {
      if (client) {
        setName(client.name);
        setColor(client.color);
        // Convert cents to dollars for display
        setRateOverride(
          client.rateOverride !== null
            ? (client.rateOverride / 100).toString()
            : ""
        );
        setIsBillable(client.isBillable);
        setParentClientId(client.parentClientId);
        // Billing configuration
        setBillingType(client.billingType);
        setBillingFrequency(client.billingFrequency);
        setAutoGenerateInvoices(client.autoGenerateInvoices ?? false);
        setRetainerAmount(
          client.retainerAmount !== null
            ? (client.retainerAmount / 100).toString()
            : ""
        );
        setBillingDayOfWeek(client.billingDayOfWeek);
        setBillingDayOfMonth(client.billingDayOfMonth);
        setPaymentTermsDays(
          client.paymentTermsDays !== null
            ? client.paymentTermsDays.toString()
            : ""
        );
        // Show billing section if any billing field is set
        setShowBillingSection(
          client.billingType !== null ||
          client.billingFrequency !== null ||
          client.autoGenerateInvoices === true ||
          client.retainerAmount !== null
        );
      } else {
        setName("");
        setColor(null);
        setRateOverride("");
        setIsBillable(null);
        setParentClientId(null);
        setBillingType(null);
        setBillingFrequency(null);
        setAutoGenerateInvoices(false);
        setRetainerAmount("");
        setBillingDayOfWeek(null);
        setBillingDayOfMonth(null);
        setPaymentTermsDays("");
        setShowBillingSection(false);
      }
      setError(null);
    }
  }, [open, client]);

  // Determine which clients can be parents:
  // - Cannot be self
  // - Cannot already have a parent (max one level of nesting)
  // - If editing and this client has children, cannot select a parent
  const hasChildren = isEditing && allClients.some((c) => c.parentClientId === client?.id);
  const availableParents = allClients.filter((c) => {
    if (isEditing && c.id === client?.id) return false; // Cannot be own parent
    if (c.parentClientId !== null) return false; // Cannot select child as parent
    return true;
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const payload = {
        name,
        color,
        rateOverride: rateOverride !== "" ? parseFloat(rateOverride) : null,
        isBillable,
        parentClientId,
        billingType,
        billingFrequency,
        autoGenerateInvoices,
        retainerAmount: retainerAmount !== "" ? parseFloat(retainerAmount) : null,
        billingDayOfWeek,
        billingDayOfMonth,
        paymentTermsDays: paymentTermsDays !== "" ? parseInt(paymentTermsDays, 10) : null,
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
        const data = await response.json();
        throw new Error(data.error || "Something went wrong");
      }

      onSuccess();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  };

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSubmit}>
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
            {/* Name */}
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Corp"
                required
                autoFocus
                className="squircle"
              />
            </div>

            {/* Parent Client */}
            {availableParents.length > 0 && !hasChildren && (
              <div className="grid gap-2">
                <Label htmlFor="parentClient">Parent Client</Label>
                <p className="text-sm text-muted-foreground">
                  Optionally nest this client under another (e.g., Agency → End Client).
                </p>
                <Select
                  value={parentClientId || "none"}
                  onValueChange={(value) => setParentClientId(value === "none" ? null : value)}
                >
                  <SelectTrigger id="parentClient" className="squircle">
                    <SelectValue placeholder="No parent (top-level)" />
                  </SelectTrigger>
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
              </div>
            )}

            {/* Show info if client has children */}
            {hasChildren && (
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                This client has sub-clients and cannot be moved under another parent.
              </div>
            )}

            {/* Color picker */}
            <div className="grid gap-2">
              <Label>Color</Label>
              <p className="text-sm text-muted-foreground">
                Choose a color to help identify this client.
              </p>
              <div className="flex flex-wrap gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setColor(color === c ? null : c)}
                    className={`size-8 rounded-full transition-all hover:scale-110 ${
                      color === c
                        ? "ring-2 ring-offset-2 ring-ring"
                        : "ring-1 ring-border"
                    }`}
                    style={{ backgroundColor: c }}
                    aria-label={`Select color ${c}`}
                  />
                ))}
              </div>
            </div>

            {/* Hourly rate override */}
            <div className="grid gap-2">
              <Label htmlFor="rate">Hourly rate override</Label>
              <p className="text-sm text-muted-foreground">
                Leave blank to use your organization&apos;s default rate.
              </p>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <Input
                  id="rate"
                  type="number"
                  min="0"
                  step="0.01"
                  value={rateOverride}
                  onChange={(e) => setRateOverride(e.target.value)}
                  placeholder="0.00"
                  className="squircle pl-7"
                />
              </div>
            </div>

            {/* Billable toggle */}
            <div className="flex items-start gap-3">
              <Checkbox
                id="billable"
                checked={isBillable === true}
                onCheckedChange={(checked) => {
                  // null means inherit, true/false means explicit
                  if (checked === "indeterminate") {
                    return;
                  }
                  if (checked) {
                    setIsBillable(true);
                  } else if (isBillable === true) {
                    // Was checked, now unchecking -> set to explicit false
                    setIsBillable(false);
                  } else {
                    // Was false or null, now unchecking -> reset to null (inherit)
                    setIsBillable(null);
                  }
                }}
                className="mt-0.5"
              />
              <div className="grid gap-1">
                <Label htmlFor="billable" className="cursor-pointer">
                  Billable
                </Label>
                <p className="text-sm text-muted-foreground">
                  {isBillable === null
                    ? "Inherits from organization settings."
                    : isBillable
                    ? "Time tracked for this client is billable."
                    : "Time tracked for this client is not billable."}
                </p>
              </div>
            </div>

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
                  {/* Billing Type */}
                  <div className="grid gap-2">
                    <Label htmlFor="billingType">Billing Type</Label>
                    <Select
                      value={billingType || ""}
                      onValueChange={(value) => setBillingType(value || null)}
                    >
                      <SelectTrigger id="billingType" className="squircle">
                        <SelectValue placeholder="Select billing type..." />
                      </SelectTrigger>
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
                  </div>

                  {/* Retainer Amount (only for retainer types) */}
                  {billingType && billingType.includes("retainer") && (
                    <div className="grid gap-2">
                      <Label htmlFor="retainerAmount">
                        {billingType === "retainer_fixed"
                          ? "Fixed Retainer Amount"
                          : billingType === "retainer_capped"
                          ? "Maximum Amount (Cap)"
                          : "Minimum Retainer Amount"}
                      </Label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                          $
                        </span>
                        <Input
                          id="retainerAmount"
                          type="number"
                          min="0"
                          step="0.01"
                          value={retainerAmount}
                          onChange={(e) => setRetainerAmount(e.target.value)}
                          placeholder="0.00"
                          className="squircle pl-7"
                        />
                      </div>
                    </div>
                  )}

                  {/* Billing Frequency */}
                  <div className="grid gap-2">
                    <Label htmlFor="billingFrequency">Billing Frequency</Label>
                    <Select
                      value={billingFrequency || ""}
                      onValueChange={(value) => setBillingFrequency(value || null)}
                    >
                      <SelectTrigger id="billingFrequency" className="squircle">
                        <SelectValue placeholder="Select frequency..." />
                      </SelectTrigger>
                      <SelectContent className="squircle">
                        {BILLING_FREQUENCIES.map((freq) => (
                          <SelectItem key={freq.value} value={freq.value}>
                            {freq.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Billing Day (conditional based on frequency) */}
                  {billingFrequency === "weekly" || billingFrequency === "biweekly" ? (
                    <div className="grid gap-2">
                      <Label htmlFor="billingDayOfWeek">Billing Day</Label>
                      <Select
                        value={billingDayOfWeek?.toString() || ""}
                        onValueChange={(value) =>
                          setBillingDayOfWeek(value ? parseInt(value, 10) : null)
                        }
                      >
                        <SelectTrigger id="billingDayOfWeek" className="squircle">
                          <SelectValue placeholder="Select day..." />
                        </SelectTrigger>
                        <SelectContent className="squircle">
                          {DAYS_OF_WEEK.map((day) => (
                            <SelectItem key={day.value} value={day.value.toString()}>
                              {day.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ) : billingFrequency === "monthly" || billingFrequency === "quarterly" ? (
                    <div className="grid gap-2">
                      <Label htmlFor="billingDayOfMonth">Billing Day of Month</Label>
                      <Input
                        id="billingDayOfMonth"
                        type="number"
                        min="1"
                        max="31"
                        value={billingDayOfMonth?.toString() || ""}
                        onChange={(e) =>
                          setBillingDayOfMonth(
                            e.target.value ? parseInt(e.target.value, 10) : null
                          )
                        }
                        placeholder="1-31"
                        className="squircle"
                      />
                      <p className="text-xs text-muted-foreground">
                        For months with fewer days, billing will occur on the last day.
                      </p>
                    </div>
                  ) : null}

                  {/* Payment Terms */}
                  <div className="grid gap-2">
                    <Label htmlFor="paymentTermsDays">Payment Terms (Net Days)</Label>
                    <Input
                      id="paymentTermsDays"
                      type="number"
                      min="0"
                      max="365"
                      value={paymentTermsDays}
                      onChange={(e) => setPaymentTermsDays(e.target.value)}
                      placeholder="30"
                      className="squircle"
                    />
                    <p className="text-xs text-muted-foreground">
                      Leave blank to use organization default.
                    </p>
                  </div>

                  {/* Auto-generate Invoices */}
                  {billingFrequency && billingFrequency !== "per_project" && (
                    <div className="flex items-center justify-between">
                      <div className="grid gap-1">
                        <Label htmlFor="autoGenerate">Auto-generate Invoices</Label>
                        <p className="text-xs text-muted-foreground">
                          Automatically create invoices on the billing schedule.
                        </p>
                      </div>
                      <Switch
                        id="autoGenerate"
                        checked={autoGenerateInvoices}
                        onCheckedChange={setAutoGenerateInvoices}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}
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
                      This will permanently delete &quot;{client?.name}&quot; and all
                      associated projects and time entries. This action cannot
                      be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
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
              disabled={isLoading || isDeleting || !name.trim()}
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              {isEditing ? "Save changes" : "Create client"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

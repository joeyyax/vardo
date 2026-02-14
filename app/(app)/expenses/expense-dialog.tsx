"use client";

import { useState, useEffect } from "react";
import { format, addMonths, addWeeks, addYears } from "date-fns";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
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
import { Switch } from "@/components/ui/switch";
import { Loader2, RefreshCw, Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type Project = {
  id: string;
  name: string;
  client: {
    id: string;
    name: string;
  };
};

type Expense = {
  id: string;
  description: string;
  amountCents: number;
  date: string;
  category: string | null;
  vendor?: string | null;
  status?: string | null;
  isBillable: boolean;
  isRecurring: boolean;
  recurringFrequency: string | null;
  project: {
    id: string;
    name: string;
    client: {
      id: string;
      name: string;
    };
  } | null;
};

type ExpenseDialogProps = {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  expense?: Expense | null;
};

const DEFAULT_CATEGORIES = [
  "Software",
  "Hosting",
  "Contractor",
  "Travel",
  "Supplies",
  "Equipment",
  "Marketing",
  "Insurance",
  "Subscriptions",
  "Other",
];

const RECURRING_FREQUENCIES = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
  { value: "yearly", label: "Yearly" },
];

function calculateNextOccurrence(date: string, frequency: string): string {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      return format(addWeeks(d, 1), "yyyy-MM-dd");
    case "monthly":
      return format(addMonths(d, 1), "yyyy-MM-dd");
    case "quarterly":
      return format(addMonths(d, 3), "yyyy-MM-dd");
    case "yearly":
      return format(addYears(d, 1), "yyyy-MM-dd");
    default:
      return format(addMonths(d, 1), "yyyy-MM-dd");
  }
}

export function ExpenseDialog({
  orgId,
  open,
  onOpenChange,
  onSuccess,
  expense,
}: ExpenseDialogProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [vendors, setVendors] = useState<string[]>([]);
  const [vendorOpen, setVendorOpen] = useState(false);
  const [vendorSearch, setVendorSearch] = useState("");

  // Form state
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("");
  const [projectId, setProjectId] = useState("none");
  const [vendor, setVendor] = useState("");
  const [status, setStatus] = useState("paid");
  const [isBillable, setIsBillable] = useState(false);
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurringFrequency, setRecurringFrequency] = useState("monthly");

  const isEditMode = !!expense;

  function resetForm() {
    setDescription("");
    setAmount("");
    setDate(format(new Date(), "yyyy-MM-dd"));
    setCategory("");
    setProjectId("none");
    setVendor("");
    setStatus("paid");
    setIsBillable(false);
    setIsRecurring(false);
    setRecurringFrequency("monthly");
    setVendorSearch("");
  }

  function populateFromExpense(exp: Expense) {
    setDescription(exp.description);
    setAmount((exp.amountCents / 100).toFixed(2));
    setDate(exp.date);
    setCategory(exp.category || "");
    setProjectId(exp.project?.id || "none");
    setVendor(exp.vendor || "");
    setStatus(exp.status || "paid");
    setIsBillable(exp.isBillable);
    setIsRecurring(exp.isRecurring);
    setRecurringFrequency(exp.recurringFrequency || "monthly");
    setVendorSearch("");
  }

  // Reset/populate form when dialog opens
  useEffect(() => {
    if (open) {
      if (expense) {
        populateFromExpense(expense);
      } else {
        resetForm();
      }
      fetchProjects();
      fetchVendors();
    }
  }, [open, expense]);

  async function fetchVendors() {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/expenses`);
      if (response.ok) {
        const data = await response.json();
        setVendors(data.vendors || []);
      }
    } catch (err) {
      console.error("Error fetching vendors:", err);
    }
  }

  async function fetchProjects() {
    setProjectsLoading(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    } finally {
      setProjectsLoading(false);
    }
  }

  async function handleSubmit() {
    if (!description.trim()) {
      toast.error("Description is required");
      return;
    }

    const amountValue = parseFloat(amount);
    if (isNaN(amountValue) || amountValue <= 0) {
      toast.error("Valid amount is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        description: description.trim(),
        amountCents: Math.round(amountValue * 100),
        date,
        category: category || null,
        projectId: projectId === "none" ? null : projectId,
        isBillable,
        isRecurring,
        recurringFrequency: isRecurring ? recurringFrequency : null,
        nextOccurrence: isRecurring
          ? calculateNextOccurrence(date, recurringFrequency)
          : null,
        vendor: vendor || null,
        status: status || "paid",
      };

      const url = isEditMode
        ? `/api/v1/organizations/${orgId}/expenses/${expense.id}`
        : `/api/v1/organizations/${orgId}/expenses`;

      const response = await fetch(url, {
        method: isEditMode ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        toast.success(isEditMode ? "Expense updated" : "Expense added");
        onSuccess();
      } else {
        const responseData = await response.json();
        toast.error(responseData.error || `Failed to ${isEditMode ? "update" : "add"} expense`);
      }
    } catch {
      toast.error(`Failed to ${isEditMode ? "update" : "add"} expense`);
    } finally {
      setIsSubmitting(false);
    }
  }

  // Group projects by client for the dropdown
  const projectsByClient = projects.reduce(
    (acc, project) => {
      const clientName = project.client.name;
      if (!acc[clientName]) {
        acc[clientName] = [];
      }
      acc[clientName].push(project);
      return acc;
    },
    {} as Record<string, Project[]>
  );

  const filteredVendors = vendors.filter(
    (v) =>
      !vendorSearch ||
      v.toLowerCase().includes(vendorSearch.toLowerCase())
  );

  return (
    <BottomSheet open={open} onOpenChange={(o) => {
      onOpenChange(o);
      if (!o) resetForm();
    }}>
      <BottomSheetContent className="squircle">
        <BottomSheetHeader>
          <BottomSheetTitle>
            {isEditMode ? "Edit Expense" : "Add Expense"}
          </BottomSheetTitle>
          <BottomSheetDescription>
            {isEditMode ? "Update the expense details." : "Record a new expense."}
          </BottomSheetDescription>
        </BottomSheetHeader>
        <div className="flex-1 overflow-y-auto px-6 pb-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g., Figma subscription"
                className="squircle"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="amount"
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className="squircle pl-7"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="date">
                  {isRecurring ? "Start Date" : "Date"}
                </Label>
                <Input
                  id="date"
                  type="date"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                  className="squircle"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select value={category} onValueChange={setCategory}>
                  <SelectTrigger id="category" className="squircle">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    {DEFAULT_CATEGORIES.map((cat) => (
                      <SelectItem key={cat} value={cat}>
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Payment Status</Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger id="status" className="squircle">
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    <SelectItem value="paid">Paid</SelectItem>
                    <SelectItem value="unpaid">Unpaid</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Vendor</Label>
              <Popover open={vendorOpen} onOpenChange={setVendorOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={vendorOpen}
                    className={cn(
                      "w-full squircle justify-between font-normal",
                      !vendor && "text-muted-foreground"
                    )}
                  >
                    {vendor || "Select or type a vendor..."}
                    <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  className="w-[--radix-popover-trigger-width] p-0"
                  align="start"
                >
                  <Command shouldFilter={false}>
                    <CommandInput
                      placeholder="Search vendors..."
                      value={vendorSearch}
                      onValueChange={setVendorSearch}
                    />
                    <CommandList>
                      {vendorSearch &&
                        !vendors.some(
                          (v) =>
                            v.toLowerCase() ===
                            vendorSearch.toLowerCase()
                        ) && (
                          <CommandGroup heading="New">
                            <CommandItem
                              value={vendorSearch}
                              onSelect={() => {
                                setVendor(vendorSearch);
                                setVendorSearch("");
                                setVendorOpen(false);
                              }}
                            >
                              Add &ldquo;{vendorSearch}&rdquo;
                            </CommandItem>
                          </CommandGroup>
                        )}

                      {filteredVendors.length === 0 && !vendorSearch && (
                        <CommandEmpty>No vendors found.</CommandEmpty>
                      )}

                      {filteredVendors.length > 0 && (
                        <CommandGroup heading="Recent vendors">
                          {filteredVendors.map((v) => (
                            <CommandItem
                              key={v}
                              value={v}
                              onSelect={() => {
                                setVendor(v);
                                setVendorSearch("");
                                setVendorOpen(false);
                              }}
                              className="flex items-center justify-between"
                            >
                              {v}
                              {vendor === v && (
                                <Check className="size-4 text-primary shrink-0" />
                              )}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      )}

                      {vendor && (
                        <CommandGroup>
                          <CommandItem
                            value="__clear__"
                            onSelect={() => {
                              setVendor("");
                              setVendorSearch("");
                              setVendorOpen(false);
                            }}
                            className="text-muted-foreground"
                          >
                            Clear vendor
                          </CommandItem>
                        </CommandGroup>
                      )}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label htmlFor="project">Project (optional)</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger id="project" className="squircle">
                  <SelectValue placeholder="Select project" />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="none">
                    <span className="text-muted-foreground">
                      General Business (Overhead)
                    </span>
                  </SelectItem>
                  {projectsLoading ? (
                    <div className="flex items-center justify-center py-2">
                      <Loader2 className="size-4 animate-spin" />
                    </div>
                  ) : (
                    Object.entries(projectsByClient).map(
                      ([clientName, clientProjects]) => (
                        <div key={clientName}>
                          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                            {clientName}
                          </div>
                          {clientProjects.map((project) => (
                            <SelectItem
                              key={project.id}
                              value={project.id}
                            >
                              {project.name}
                            </SelectItem>
                          ))}
                        </div>
                      )
                    )
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <RefreshCw className="size-4 text-muted-foreground" />
                <Label htmlFor="recurring" className="cursor-pointer">
                  Recurring expense
                </Label>
              </div>
              <Switch
                id="recurring"
                checked={isRecurring}
                onCheckedChange={setIsRecurring}
              />
            </div>

            {isRecurring && (
              <div className="space-y-2">
                <Label htmlFor="frequency">Frequency</Label>
                <Select value={recurringFrequency} onValueChange={setRecurringFrequency}>
                  <SelectTrigger id="frequency" className="squircle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    {RECURRING_FREQUENCIES.map((freq) => (
                      <SelectItem key={freq.value} value={freq.value}>
                        {freq.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <Switch
                id="billable"
                checked={isBillable}
                onCheckedChange={setIsBillable}
                disabled={projectId === "none"}
              />
              <Label htmlFor="billable" className="cursor-pointer">
                Billable to client
              </Label>
            </div>
          </div>
        </div>
        <BottomSheetFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
            className="squircle"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || !description.trim() || !amount}
            className="squircle"
          >
            {isSubmitting && <Loader2 className="size-4 animate-spin" />}
            {isEditMode ? "Save Changes" : "Add Expense"}
          </Button>
        </BottomSheetFooter>
      </BottomSheetContent>
    </BottomSheet>
  );
}

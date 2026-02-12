"use client";

import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetDescription,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
} from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Calendar } from "@/components/ui/calendar";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  CalendarIcon,
  Check,
  ChevronsUpDown,
  Loader2,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { formatCurrency } from "@/lib/formatting";
import { z } from "zod";

type Client = {
  id: string;
  name: string;
  color: string | null;
};

const invoiceSchema = z.object({
  clientId: z.string().min(1, "Please select a client"),
  dateFrom: z.date({ error: "Start date is required" }),
  dateTo: z.date({ error: "End date is required" }),
  includeSummaries: z.boolean(),
});

type InvoiceFormData = z.infer<typeof invoiceSchema>;

type InvoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  onSuccess: () => void;
  aiSummaryAvailable?: boolean;
};

export function InvoiceDialog({
  open,
  onOpenChange,
  orgId,
  onSuccess,
  aiSummaryAvailable = false,
}: InvoiceDialogProps) {
  const form = useForm<InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: {
      clientId: "",
      dateFrom: startOfMonth(subMonths(new Date(), 1)),
      dateTo: endOfMonth(subMonths(new Date(), 1)),
      includeSummaries: aiSummaryAvailable,
    },
  });

  // UI state
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientOpen, setClientOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

  // Overlap warning state
  type OverlappingDraft = {
    id: string;
    invoiceNumber: string;
    periodStart: string;
    periodEnd: string;
    subtotal: number;
    client: { id: string; name: string; color: string | null };
  };
  const [overlappingDrafts, setOverlappingDrafts] = useState<OverlappingDraft[]>([]);
  const [showOverlapWarning, setShowOverlapWarning] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<InvoiceFormData | null>(null);

  // Fetch clients when dialog opens
  useEffect(() => {
    async function loadClients() {
      setIsLoadingClients(true);
      try {
        const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
        if (!response.ok) throw new Error("Failed to fetch clients");
        const data = await response.json();
        setClients(data);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch clients"
        );
      } finally {
        setIsLoadingClients(false);
      }
    }

    if (open && clients.length === 0) {
      loadClients();
    }
    if (!open) {
      setError(null);
    }
  }, [open, clients.length, orgId]);

  const clientId = form.watch("clientId");
  const selectedClient = clients.find((c) => c.id === clientId);

  async function submitInvoice(data: InvoiceFormData, option?: { force?: boolean; deleteOverlapping?: boolean }) {
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: data.clientId,
          from: format(data.dateFrom, "yyyy-MM-dd"),
          to: format(data.dateTo, "yyyy-MM-dd"),
          includeSummaries: data.includeSummaries,
          ...(option?.force && { force: true }),
          ...(option?.deleteOverlapping && { deleteOverlapping: true }),
        }),
      });

      if (response.status === 409) {
        const responseData = await response.json();
        setOverlappingDrafts(responseData.overlapping || []);
        setPendingFormData(data);
        setShowOverlapWarning(true);
        return;
      }

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

  async function onSubmit(data: InvoiceFormData) {
    await submitInvoice(data);
  }

  async function handleOverlapOption(option: "replace" | "force") {
    if (!pendingFormData) return;
    setShowOverlapWarning(false);
    await submitInvoice(
      pendingFormData,
      option === "replace" ? { deleteOverlapping: true } : { force: true }
    );
    setPendingFormData(null);
    setOverlappingDrafts([]);
  }

  const setQuickRange = (months: number) => {
    const target = subMonths(new Date(), months);
    form.setValue("dateFrom", startOfMonth(target));
    form.setValue("dateTo", endOfMonth(target));
  };

  const dateFrom = form.watch("dateFrom");
  const dateTo = form.watch("dateTo");

  return (
    <>
    <BottomSheet open={open} onOpenChange={onOpenChange}>
      <BottomSheetContent size="lg">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col min-h-0 flex-1">
            <BottomSheetHeader>
              <BottomSheetTitle>Generate Invoice</BottomSheetTitle>
              <BottomSheetDescription>
                Create an invoice from billable time entries.
              </BottomSheetDescription>
            </BottomSheetHeader>

            <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-6">
              <FormField
                control={form.control}
                name="clientId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client</FormLabel>
                    <Popover open={clientOpen} onOpenChange={setClientOpen}>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            role="combobox"
                            aria-expanded={clientOpen}
                            className="squircle w-full justify-between"
                            disabled={isLoadingClients}
                          >
                            {isLoadingClients ? (
                              <Loader2 className="size-4 animate-spin" />
                            ) : selectedClient ? (
                              <div className="flex items-center gap-2">
                                {selectedClient.color && (
                                  <div
                                    className="size-3 rounded-full"
                                    style={{
                                      backgroundColor: selectedClient.color,
                                    }}
                                  />
                                )}
                                {selectedClient.name}
                              </div>
                            ) : (
                              "Select client..."
                            )}
                            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="squircle w-[--radix-popover-trigger-width] p-0">
                        <Command>
                          <CommandInput placeholder="Search clients..." />
                          <CommandList>
                            <CommandEmpty>No clients found.</CommandEmpty>
                            <CommandGroup>
                              {clients.map((client) => (
                                <CommandItem
                                  key={client.id}
                                  value={client.name}
                                  onSelect={() => {
                                    field.onChange(client.id);
                                    setClientOpen(false);
                                  }}
                                >
                                  <div className="flex items-center gap-2">
                                    {client.color && (
                                      <div
                                        className="size-3 rounded-full"
                                        style={{
                                          backgroundColor: client.color,
                                        }}
                                      />
                                    )}
                                    {client.name}
                                  </div>
                                  <Check
                                    className={cn(
                                      "ml-auto size-4",
                                      field.value === client.id
                                        ? "opacity-100"
                                        : "opacity-0"
                                    )}
                                  />
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-2">
                <Label>Period</Label>
                <div className="flex gap-2 flex-wrap">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="squircle"
                    onClick={() => setQuickRange(1)}
                  >
                    Last month
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="squircle"
                    onClick={() => setQuickRange(0)}
                  >
                    This month
                  </Button>
                </div>
                <Popover open={dateOpen} onOpenChange={setDateOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "squircle justify-start text-left font-normal",
                        !dateFrom && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 size-4" />
                      {dateFrom ? (
                        dateTo ? (
                          <>
                            {format(dateFrom, "MMM d, yyyy")} -{" "}
                            {format(dateTo, "MMM d, yyyy")}
                          </>
                        ) : (
                          format(dateFrom, "MMM d, yyyy")
                        )
                      ) : (
                        "Pick a date range"
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="squircle w-auto p-0" align="start">
                    <Calendar
                      mode="range"
                      defaultMonth={dateFrom}
                      selected={{ from: dateFrom, to: dateTo }}
                      onSelect={(range) => {
                        if (range?.from) form.setValue("dateFrom", range.from);
                        if (range?.to) form.setValue("dateTo", range.to);
                      }}
                      numberOfMonths={2}
                    />
                  </PopoverContent>
                </Popover>
              </div>

              {aiSummaryAvailable && (
                <FormField
                  control={form.control}
                  name="includeSummaries"
                  render={({ field }) => (
                    <FormItem className="flex items-center justify-between gap-4 rounded-lg border p-4">
                      <div className="flex items-start gap-3">
                        <Sparkles className="size-5 text-primary mt-0.5" />
                        <div className="grid gap-1">
                          <Label
                            htmlFor="ai-summaries"
                            className="cursor-pointer"
                          >
                            AI-generated summaries
                          </Label>
                          <p className="text-sm text-muted-foreground">
                            Summarize time entry descriptions into professional
                            line items.
                          </p>
                        </div>
                      </div>
                      <FormControl>
                        <Switch
                          id="ai-summaries"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}
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
                disabled={isLoading || !clientId || !dateFrom || !dateTo}
                className="squircle"
              >
                {isLoading && <Loader2 className="size-4 animate-spin" />}
                Generate Invoice
              </Button>
            </BottomSheetFooter>
          </form>
        </Form>
      </BottomSheetContent>
    </BottomSheet>

      {/* Overlap warning dialog */}
      <AlertDialog open={showOverlapWarning} onOpenChange={(open) => {
        setShowOverlapWarning(open);
        if (!open) {
          setPendingFormData(null);
          setOverlappingDrafts([]);
        }
      }}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Overlapping draft invoices found</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div>
                <p className="mb-3">
                  The following draft invoices overlap with the selected period:
                </p>
                <ul className="space-y-2">
                  {overlappingDrafts.map((draft) => (
                    <li key={draft.id} className="flex items-center justify-between rounded-md border px-3 py-2 text-sm">
                      <div>
                        <span className="font-medium">{draft.invoiceNumber}</span>
                        <span className="text-muted-foreground ml-2">
                          {draft.periodStart} – {draft.periodEnd}
                        </span>
                      </div>
                      <span className="font-medium tabular-nums">
                        {formatCurrency(draft.subtotal)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col sm:flex-row gap-2">
            <AlertDialogCancel className="squircle" disabled={isLoading}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="squircle"
              disabled={isLoading}
              onClick={() => handleOverlapOption("force")}
            >
              Generate anyway
            </AlertDialogAction>
            <AlertDialogAction
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isLoading}
              onClick={() => handleOverlapOption("replace")}
            >
              Replace drafts
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

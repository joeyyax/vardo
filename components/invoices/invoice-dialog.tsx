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
import { CalendarIcon, Check, ChevronsUpDown, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";

type Client = {
  id: string;
  name: string;
  color: string | null;
};

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
  // Form state
  const [clientId, setClientId] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState<{
    from: Date | undefined;
    to: Date | undefined;
  }>({
    from: startOfMonth(subMonths(new Date(), 1)),
    to: endOfMonth(subMonths(new Date(), 1)),
  });
  const [includeSummaries, setIncludeSummaries] = useState(aiSummaryAvailable);

  // UI state
  const [clients, setClients] = useState<Client[]>([]);
  const [isLoadingClients, setIsLoadingClients] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientOpen, setClientOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);

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
        setError(err instanceof Error ? err.message : "Failed to fetch clients");
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

  const selectedClient = clients.find((c) => c.id === clientId);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    if (!clientId || !dateRange.from || !dateRange.to) {
      setError("Please select a client and date range");
      setIsLoading(false);
      return;
    }

    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          from: format(dateRange.from, "yyyy-MM-dd"),
          to: format(dateRange.to, "yyyy-MM-dd"),
          includeSummaries,
        }),
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

  const setQuickRange = (months: number) => {
    const target = subMonths(new Date(), months);
    setDateRange({
      from: startOfMonth(target),
      to: endOfMonth(target),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Generate Invoice</DialogTitle>
            <DialogDescription>
              Create an invoice from billable time entries.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-5 py-6">
            {/* Client selector */}
            <div className="grid gap-2">
              <Label>Client</Label>
              <Popover open={clientOpen} onOpenChange={setClientOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={clientOpen}
                    className="squircle justify-between"
                    disabled={isLoadingClients}
                  >
                    {isLoadingClients ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : selectedClient ? (
                      <div className="flex items-center gap-2">
                        {selectedClient.color && (
                          <div
                            className="size-3 rounded-full"
                            style={{ backgroundColor: selectedClient.color }}
                          />
                        )}
                        {selectedClient.name}
                      </div>
                    ) : (
                      "Select client..."
                    )}
                    <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
                  </Button>
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
                              setClientId(client.id);
                              setClientOpen(false);
                            }}
                          >
                            <div className="flex items-center gap-2">
                              {client.color && (
                                <div
                                  className="size-3 rounded-full"
                                  style={{ backgroundColor: client.color }}
                                />
                              )}
                              {client.name}
                            </div>
                            <Check
                              className={cn(
                                "ml-auto size-4",
                                clientId === client.id
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
            </div>

            {/* Date range */}
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
                      !dateRange.from && "text-muted-foreground"
                    )}
                  >
                    <CalendarIcon className="mr-2 size-4" />
                    {dateRange.from ? (
                      dateRange.to ? (
                        <>
                          {format(dateRange.from, "MMM d, yyyy")} -{" "}
                          {format(dateRange.to, "MMM d, yyyy")}
                        </>
                      ) : (
                        format(dateRange.from, "MMM d, yyyy")
                      )
                    ) : (
                      "Pick a date range"
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="squircle w-auto p-0" align="start">
                  <Calendar
                    mode="range"
                    defaultMonth={dateRange.from}
                    selected={dateRange}
                    onSelect={(range) => {
                      setDateRange({ from: range?.from, to: range?.to });
                    }}
                    numberOfMonths={2}
                  />
                </PopoverContent>
              </Popover>
            </div>

            {/* AI summaries toggle */}
            {aiSummaryAvailable && (
              <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="size-5 text-primary mt-0.5" />
                  <div className="grid gap-1">
                    <Label htmlFor="ai-summaries" className="cursor-pointer">
                      AI-generated summaries
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      Summarize time entry descriptions into professional line
                      items.
                    </p>
                  </div>
                </div>
                <Switch
                  id="ai-summaries"
                  checked={includeSummaries}
                  onCheckedChange={setIncludeSummaries}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
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
              disabled={
                isLoading || !clientId || !dateRange.from || !dateRange.to
              }
              className="squircle"
            >
              {isLoading && <Loader2 className="size-4 animate-spin" />}
              Generate Invoice
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

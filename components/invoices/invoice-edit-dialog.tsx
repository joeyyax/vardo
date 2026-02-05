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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Trash2 } from "lucide-react";

type LineItem = {
  id: string;
  projectName: string;
  taskName: string | null;
  description: string | null;
  minutes: number;
  rate: number;
  amount: number;
};

type Invoice = {
  id: string;
  invoiceNumber: string;
  status: string | null;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  totalMinutes: number;
  publicToken: string;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
};

type InvoiceEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice | null;
  orgId: string;
  onSuccess: () => void;
};

export function InvoiceEditDialog({
  open,
  onOpenChange,
  invoice,
  orgId,
  onSuccess,
}: InvoiceEditDialogProps) {
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch invoice details when dialog opens
  useEffect(() => {
    if (open && invoice) {
      setInvoiceNumber(invoice.invoiceNumber);
      fetchLineItems();
    }
  }, [open, invoice]);

  const fetchLineItems = async () => {
    if (!invoice) return;

    setIsFetching(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/invoices/${invoice.id}`
      );
      if (!response.ok) throw new Error("Failed to fetch invoice details");
      const data = await response.json();
      setLineItems(data.lineItems || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoice");
    } finally {
      setIsFetching(false);
    }
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: string | number) => {
    setLineItems((prev) =>
      prev.map((item) => {
        if (item.id !== id) return item;

        const updated = { ...item, [field]: value };

        // Recalculate amount if minutes or rate changed
        if (field === "minutes" || field === "rate") {
          const minutes = field === "minutes" ? Number(value) : item.minutes;
          const rate = field === "rate" ? Number(value) : item.rate;
          updated.amount = Math.round((minutes / 60) * rate);
        }

        return updated;
      })
    );
  };

  const removeLineItem = (id: string) => {
    setLineItems((prev) => prev.filter((item) => item.id !== id));
  };

  const calculateTotals = () => {
    const totalMinutes = lineItems.reduce((sum, item) => sum + item.minutes, 0);
    const subtotal = lineItems.reduce((sum, item) => sum + item.amount, 0);
    return { totalMinutes, subtotal };
  };

  const handleSave = async () => {
    if (!invoice) return;

    setIsLoading(true);
    setError(null);

    try {
      const { totalMinutes, subtotal } = calculateTotals();

      const response = await fetch(
        `/api/v1/organizations/${orgId}/invoices/${invoice.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invoiceNumber,
            totalMinutes,
            subtotal,
            lineItems: lineItems.map((item) => ({
              id: item.id,
              description: item.description,
              minutes: item.minutes,
              rate: item.rate,
              amount: item.amount,
            })),
          }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update invoice");
      }

      onOpenChange(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsLoading(false);
    }
  };

  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatHours = (minutes: number) => (minutes / 60).toFixed(2);

  const { totalMinutes, subtotal } = calculateTotals();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="squircle max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Invoice</DialogTitle>
          <DialogDescription>
            {invoice?.client.name} • {invoice?.periodStart} to {invoice?.periodEnd}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {isFetching ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Invoice Number */}
            <div className="space-y-2">
              <Label htmlFor="invoice-number">Invoice Number</Label>
              <Input
                id="invoice-number"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="squircle max-w-xs"
              />
            </div>

            {/* Line Items */}
            <div className="space-y-3">
              <Label>Line Items</Label>
              <div className="rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium">Description</th>
                      <th className="px-3 py-2 text-right font-medium w-24">Hours</th>
                      <th className="px-3 py-2 text-right font-medium w-28">Rate</th>
                      <th className="px-3 py-2 text-right font-medium w-28">Amount</th>
                      <th className="px-3 py-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <div className="space-y-1">
                            <div className="font-medium">{item.projectName}</div>
                            {item.taskName && (
                              <div className="text-xs text-muted-foreground">
                                {item.taskName}
                              </div>
                            )}
                            <Input
                              value={item.description || ""}
                              onChange={(e) =>
                                updateLineItem(item.id, "description", e.target.value)
                              }
                              placeholder="Description"
                              className="squircle h-8 text-sm"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <Input
                            type="number"
                            step="0.25"
                            value={formatHours(item.minutes)}
                            onChange={(e) =>
                              updateLineItem(
                                item.id,
                                "minutes",
                                Math.round(parseFloat(e.target.value || "0") * 60)
                              )
                            }
                            className="squircle h-8 text-right tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center">
                            <span className="text-muted-foreground mr-1">$</span>
                            <Input
                              type="number"
                              step="0.01"
                              value={(item.rate / 100).toFixed(2)}
                              onChange={(e) =>
                                updateLineItem(
                                  item.id,
                                  "rate",
                                  Math.round(parseFloat(e.target.value || "0") * 100)
                                )
                              }
                              className="squircle h-8 text-right tabular-nums"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {formatCurrency(item.amount)}
                        </td>
                        <td className="px-3 py-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-destructive"
                            onClick={() => removeLineItem(item.id)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Total Hours</span>
                  <span className="tabular-nums">{formatHours(totalMinutes)}</span>
                </div>
                <div className="flex justify-between border-t pt-2 text-lg font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(subtotal)}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
            className="squircle"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={isLoading || isFetching}
            className="squircle"
          >
            {isLoading && <Loader2 className="size-4 animate-spin" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

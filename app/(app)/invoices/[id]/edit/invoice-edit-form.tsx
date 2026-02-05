"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
  notes: string | null;
  includeTimesheet: boolean;
  client: {
    id: string;
    name: string;
    color: string | null;
  };
};

type InvoiceEditFormProps = {
  invoice: Invoice;
  lineItems: LineItem[];
  orgId: string;
};

export function InvoiceEditForm({
  invoice: initialInvoice,
  lineItems: initialLineItems,
  orgId,
}: InvoiceEditFormProps) {
  const router = useRouter();
  const [invoiceNumber, setInvoiceNumber] = useState(initialInvoice.invoiceNumber);
  const [notes, setNotes] = useState(initialInvoice.notes || "");
  const [includeTimesheet, setIncludeTimesheet] = useState(initialInvoice.includeTimesheet);
  const [lineItems, setLineItems] = useState(initialLineItems);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setIsLoading(true);
    setError(null);

    try {
      const { totalMinutes, subtotal } = calculateTotals();

      const response = await fetch(
        `/api/v1/organizations/${orgId}/invoices/${initialInvoice.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invoiceNumber,
            notes: notes || null,
            includeTimesheet,
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

      router.push("/invoices");
      router.refresh();
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
    <>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Edit Invoice</h1>
            <p className="text-muted-foreground">
              {initialInvoice.client.name} • {initialInvoice.periodStart} to{" "}
              {initialInvoice.periodEnd}
            </p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={isLoading} className="squircle">
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          Save Changes
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-6">
          {/* Line Items */}
          <Card className="squircle">
            <CardHeader>
              <CardTitle>Line Items</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-4 py-3 text-left font-medium">Description</th>
                      <th className="px-4 py-3 text-right font-medium w-24">Hours</th>
                      <th className="px-4 py-3 text-right font-medium w-28">Rate</th>
                      <th className="px-4 py-3 text-right font-medium w-28">Amount</th>
                      <th className="px-4 py-3 w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((item) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <div className="space-y-2">
                            <div>
                              <div className="font-medium">{item.projectName}</div>
                              {item.taskName && (
                                <div className="text-xs text-muted-foreground">
                                  {item.taskName}
                                </div>
                              )}
                            </div>
                            <Textarea
                              value={item.description || ""}
                              onChange={(e) =>
                                updateLineItem(item.id, "description", e.target.value)
                              }
                              placeholder="Add a summary or description..."
                              rows={2}
                              className="squircle text-sm resize-none"
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 align-top">
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
                            className="squircle text-right tabular-nums"
                          />
                        </td>
                        <td className="px-4 py-3 align-top">
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
                              className="squircle text-right tabular-nums"
                            />
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums font-medium align-top pt-5">
                          {formatCurrency(item.amount)}
                        </td>
                        <td className="px-4 py-3 align-top">
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

              {lineItems.length === 0 && (
                <p className="text-center py-8 text-muted-foreground">
                  No line items remaining.
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Sidebar */}
        <div className="space-y-6">
          {/* Invoice Details */}
          <Card className="squircle">
            <CardHeader>
              <CardTitle>Invoice Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="invoice-number">Invoice Number</Label>
                <Input
                  id="invoice-number"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  className="squircle"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Additional notes for the client..."
                  rows={4}
                  className="squircle resize-none"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label htmlFor="include-timesheet">Include Timesheet</Label>
                  <p className="text-xs text-muted-foreground">
                    Attach detailed time entries
                  </p>
                </div>
                <Switch
                  id="include-timesheet"
                  checked={includeTimesheet}
                  onCheckedChange={setIncludeTimesheet}
                />
              </div>
            </CardContent>
          </Card>

          {/* Totals */}
          <Card className="squircle">
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Total Hours</span>
                <span className="tabular-nums font-medium">
                  {formatHours(totalMinutes)}
                </span>
              </div>
              <div className="flex justify-between border-t pt-3 text-lg font-bold">
                <span>Total</span>
                <span className="tabular-nums">{formatCurrency(subtotal)}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

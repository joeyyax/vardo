"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import {
  invoiceEditSchema,
  type InvoiceEditFormData,
  type InvoiceLineItem,
} from "@/lib/schemas/invoice-edit";

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
  lineItems: InvoiceLineItem[];
  orgId: string;
};

export function InvoiceEditForm({
  invoice: initialInvoice,
  lineItems: initialLineItems,
  orgId,
}: InvoiceEditFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<InvoiceEditFormData>({
    resolver: zodResolver(invoiceEditSchema),
    defaultValues: {
      invoiceNumber: initialInvoice.invoiceNumber,
      notes: initialInvoice.notes || "",
      includeTimesheet: initialInvoice.includeTimesheet,
      lineItems: initialLineItems,
    },
  });

  const { fields, remove, update } = useFieldArray({
    control: form.control,
    name: "lineItems",
  });

  const updateLineItem = (
    index: number,
    field: keyof InvoiceLineItem,
    value: string | number | null
  ) => {
    const currentItem = fields[index];
    const updated = { ...currentItem, [field]: value };

    // Recalculate amount if minutes or rate changed
    if (field === "minutes" || field === "rate") {
      const minutes = field === "minutes" ? Number(value) : currentItem.minutes;
      const rate = field === "rate" ? Number(value) : currentItem.rate;
      updated.amount = Math.round((minutes / 60) * rate);
    }

    update(index, updated);
  };

  const calculateTotals = () => {
    const items = form.getValues("lineItems");
    const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
    const subtotal = items.reduce((sum, item) => sum + item.amount, 0);
    return { totalMinutes, subtotal };
  };

  const onSubmit = async (data: InvoiceEditFormData) => {
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
            invoiceNumber: data.invoiceNumber,
            notes: data.notes || null,
            includeTimesheet: data.includeTimesheet,
            totalMinutes,
            subtotal,
            lineItems: data.lineItems.map((item) => ({
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
        const responseData = await response.json();
        throw new Error(responseData.error || "Failed to update invoice");
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
    <Form {...form}>
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/invoices">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              Edit Invoice
            </h1>
            <p className="text-muted-foreground">
              {initialInvoice.client.name} • {initialInvoice.periodStart} to{" "}
              {initialInvoice.periodEnd}
            </p>
          </div>
        </div>
        <Button
          onClick={form.handleSubmit(onSubmit)}
          disabled={isLoading}
          className="squircle"
        >
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
                      <th className="px-4 py-3 text-left font-medium">
                        Description
                      </th>
                      <th className="px-4 py-3 text-right font-medium w-24">
                        Hours
                      </th>
                      <th className="px-4 py-3 text-right font-medium w-28">
                        Rate
                      </th>
                      <th className="px-4 py-3 text-right font-medium w-28">
                        Amount
                      </th>
                      <th className="px-4 py-3 w-12"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((item, index) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-4 py-3">
                          <div className="space-y-2">
                            <div>
                              <div className="font-medium">
                                {item.projectName}
                              </div>
                              {item.taskName && (
                                <div className="text-xs text-muted-foreground">
                                  {item.taskName}
                                </div>
                              )}
                            </div>
                            <Textarea
                              value={item.description || ""}
                              onChange={(e) =>
                                updateLineItem(
                                  index,
                                  "description",
                                  e.target.value
                                )
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
                                index,
                                "minutes",
                                Math.round(
                                  parseFloat(e.target.value || "0") * 60
                                )
                              )
                            }
                            className="squircle text-right tabular-nums"
                          />
                        </td>
                        <td className="px-4 py-3 align-top">
                          <div className="flex items-center">
                            <span className="text-muted-foreground mr-1">
                              $
                            </span>
                            <Input
                              type="number"
                              step="0.01"
                              value={(item.rate / 100).toFixed(2)}
                              onChange={(e) =>
                                updateLineItem(
                                  index,
                                  "rate",
                                  Math.round(
                                    parseFloat(e.target.value || "0") * 100
                                  )
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
                            onClick={() => remove(index)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {fields.length === 0 && (
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
              <FormField
                control={form.control}
                name="invoiceNumber"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Invoice Number</FormLabel>
                    <FormControl>
                      <Input {...field} className="squircle" />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Additional notes for the client..."
                        rows={4}
                        className="squircle resize-none"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="includeTimesheet"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <FormLabel>Include Timesheet</FormLabel>
                      <FormDescription>
                        Attach detailed time entries
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
    </Form>
  );
}

"use client";

import { useState, useEffect } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DetailModal } from "@/components/ui/detail-modal";
import { IconButton } from "@/components/ui/icon-button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Trash2, Save } from "lucide-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
} from "@/components/ui/form";
import {
  invoiceEditDialogSchema,
  type InvoiceEditDialogFormData,
  type InvoiceLineItem,
} from "@/lib/schemas/invoice-edit";
import { formatHoursDecimal } from "@/lib/formatting";
import { InvoiceComments } from "./invoice-comments";

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
  currentUserId?: string;
};

export function InvoiceEditDialog({
  open,
  onOpenChange,
  invoice,
  orgId,
  onSuccess,
  currentUserId,
}: InvoiceEditDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<InvoiceEditDialogFormData>({
    resolver: zodResolver(invoiceEditDialogSchema),
    defaultValues: {
      invoiceNumber: "",
      lineItems: [],
    },
  });

  const { fields, remove, update } = useFieldArray({
    control: form.control,
    name: "lineItems",
  });

  useEffect(() => {
    if (open && invoice) {
      form.setValue("invoiceNumber", invoice.invoiceNumber);
      fetchLineItems();
    }
  }, [open, invoice, form]);

  const fetchLineItems = async () => {
    if (!invoice) return;

    setIsFetching(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/invoices/${invoice.id}`
      );
      if (!response.ok) throw new Error("Failed to fetch invoice details");
      const data = await response.json();
      form.setValue("lineItems", data.lineItems || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invoice");
    } finally {
      setIsFetching(false);
    }
  };

  const updateLineItem = (
    index: number,
    field: keyof InvoiceLineItem,
    value: string | number | null
  ) => {
    const currentItem = fields[index];
    const updated = { ...currentItem, [field]: value };

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

  const onSubmit = async (data: InvoiceEditDialogFormData) => {
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
            invoiceNumber: data.invoiceNumber,
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

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsLoading(false);
    }
  };

  const formatCurrency = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  const formatHours = formatHoursDecimal;

  const { totalMinutes, subtotal } = calculateTotals();

  const actions = (
    <IconButton
      icon={Save}
      tooltip="Save Changes"
      loading={isLoading}
      disabled={isFetching}
      onClick={() => form.handleSubmit(onSubmit)()}
    />
  );

  const sidebar =
    invoice && currentUserId ? (
      <InvoiceComments
        invoiceId={invoice.id}
        orgId={orgId}
        currentUserId={currentUserId}
        onUpdate={onSuccess}
      />
    ) : undefined;

  return (
    <DetailModal
      open={open}
      onOpenChange={onOpenChange}
      title="Edit Invoice"
      description={
        invoice
          ? `${invoice.client.name} \u2022 ${invoice.periodStart} to ${invoice.periodEnd}`
          : undefined
      }
      actions={actions}
      sidebar={sidebar}
    >
      {error && (
        <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {isFetching ? (
        <LoadingSpinner fullHeight={false} size="size-6" />
      ) : (
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-6"
            id="invoice-edit-form"
          >
            <FormField
              control={form.control}
              name="invoiceNumber"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Invoice Number</FormLabel>
                  <FormControl>
                    <Input {...field} className="squircle max-w-xs" />
                  </FormControl>
                </FormItem>
              )}
            />

            <div className="space-y-3">
              <FormLabel>Line Items</FormLabel>
              <div className="rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="px-3 py-2 text-left font-medium">
                        Description
                      </th>
                      <th className="px-3 py-2 text-right font-medium w-24">
                        Hours
                      </th>
                      <th className="px-3 py-2 text-right font-medium w-28">
                        Rate
                      </th>
                      <th className="px-3 py-2 text-right font-medium w-28">
                        Amount
                      </th>
                      <th className="px-3 py-2 w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {fields.map((item, index) => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <div className="space-y-1">
                            <div className="font-medium">
                              {item.projectName}
                            </div>
                            {item.taskName && (
                              <div className="text-xs text-muted-foreground">
                                {item.taskName}
                              </div>
                            )}
                            <Input
                              value={item.description || ""}
                              onChange={(e) =>
                                updateLineItem(
                                  index,
                                  "description",
                                  e.target.value
                                )
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
                                index,
                                "minutes",
                                Math.round(
                                  parseFloat(e.target.value || "0") * 60
                                )
                              )
                            }
                            className="squircle h-8 text-right tabular-nums"
                          />
                        </td>
                        <td className="px-3 py-2">
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
                              className="squircle h-8 text-right tabular-nums"
                            />
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {formatCurrency(item.amount)}
                        </td>
                        <td className="px-3 py-2">
                          <Button
                            type="button"
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
            </div>

            <div className="flex justify-end">
              <div className="w-64 space-y-2 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Total Hours</span>
                  <span className="tabular-nums">
                    {formatHours(totalMinutes)}
                  </span>
                </div>
                <div className="flex justify-between border-t pt-2 text-lg font-bold">
                  <span>Total</span>
                  <span className="tabular-nums">
                    {formatCurrency(subtotal)}
                  </span>
                </div>
              </div>
            </div>
          </form>
        </Form>
      )}
    </DetailModal>
  );
}

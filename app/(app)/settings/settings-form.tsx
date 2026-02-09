"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { z } from "zod";
import type { OrgFeatures } from "@/lib/db/schema";

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

const organizationSettingsSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  defaultRate: z.string(),
  roundingIncrement: z.string(),
  defaultBillingType: z.string(),
  defaultBillingFrequency: z.string(),
  defaultPaymentTermsDays: z.string(),
});

type OrganizationSettingsFormData = z.infer<typeof organizationSettingsSchema>;

type Organization = {
  id: string;
  name: string;
  slug: string;
  defaultRate: number | null;
  roundingIncrement: number | null;
  defaultBillingType: string | null;
  defaultBillingFrequency: string | null;
  defaultPaymentTermsDays: number | null;
};

type Props = {
  organization: Organization;
  canEdit: boolean;
  features: OrgFeatures;
};

export function SettingsForm({ organization, canEdit, features }: Props) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const form = useForm<OrganizationSettingsFormData>({
    resolver: zodResolver(organizationSettingsSchema),
    defaultValues: {
      name: organization.name,
      defaultRate: organization.defaultRate
        ? (organization.defaultRate / 100).toString()
        : "",
      roundingIncrement: (organization.roundingIncrement ?? 15).toString(),
      defaultBillingType: organization.defaultBillingType || "none",
      defaultBillingFrequency: organization.defaultBillingFrequency || "none",
      defaultPaymentTermsDays: (
        organization.defaultPaymentTermsDays ?? 30
      ).toString(),
    },
  });

  async function onSubmit(data: OrganizationSettingsFormData) {
    setError(null);
    setSuccess(false);
    setIsLoading(true);

    try {
      const rateInCents = data.defaultRate
        ? Math.round(parseFloat(data.defaultRate) * 100)
        : null;

      const response = await fetch(`/api/v1/organizations/${organization.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: data.name.trim(),
          defaultRate: rateInCents,
          roundingIncrement: parseInt(data.roundingIncrement, 10),
          defaultBillingType:
            data.defaultBillingType === "none"
              ? null
              : data.defaultBillingType,
          defaultBillingFrequency:
            data.defaultBillingFrequency === "none"
              ? null
              : data.defaultBillingFrequency,
          defaultPaymentTermsDays: data.defaultPaymentTermsDays
            ? parseInt(data.defaultPaymentTermsDays, 10)
            : null,
        }),
      });

      if (!response.ok) {
        const responseData = await response.json();
        throw new Error(responseData.error || "Failed to update settings");
      }

      setSuccess(true);
      router.refresh();

      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Card className="max-w-2xl squircle">
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          Manage your organization&apos;s general settings and defaults.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Organization name</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      disabled={!canEdit || isLoading}
                      className="max-w-sm squircle"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {features.time_tracking && (
              <>
                <FormField
                  control={form.control}
                  name="defaultRate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default hourly rate</FormLabel>
                      <div className="flex items-center gap-2 max-w-sm">
                        <span className="text-muted-foreground">$</span>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            disabled={!canEdit || isLoading}
                            className="squircle"
                          />
                        </FormControl>
                        <span className="text-muted-foreground text-sm whitespace-nowrap">
                          per hour
                        </span>
                      </div>
                      <FormDescription>
                        This rate is used when clients or projects don&apos;t
                        have their own rate set.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="roundingIncrement"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Time rounding</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={!canEdit || isLoading}
                      >
                        <FormControl>
                          <SelectTrigger className="max-w-sm squircle">
                            <SelectValue placeholder="Select rounding increment" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="5">5 minutes</SelectItem>
                          <SelectItem value="10">10 minutes</SelectItem>
                          <SelectItem value="15">15 minutes</SelectItem>
                          <SelectItem value="30">30 minutes</SelectItem>
                          <SelectItem value="60">1 hour</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        Time entries will be rounded to the nearest increment.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {features.invoicing && (
              <>
                <div className="border-t pt-6">
                  <h3 className="text-sm font-medium mb-1">Billing Defaults</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    Default billing settings applied to new clients.
                  </p>
                </div>

                <FormField
                  control={form.control}
                  name="defaultBillingType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default billing type</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={!canEdit || isLoading}
                      >
                        <FormControl>
                          <SelectTrigger className="max-w-sm squircle">
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
                      <FormDescription>
                        New clients will default to this billing type.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultBillingFrequency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default billing frequency</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        disabled={!canEdit || isLoading}
                      >
                        <FormControl>
                          <SelectTrigger className="max-w-sm squircle">
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
                      <FormDescription>
                        How often new clients will be billed by default.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="defaultPaymentTermsDays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Default payment terms</FormLabel>
                      <div className="flex items-center gap-2 max-w-sm">
                        <span className="text-muted-foreground text-sm">
                          Net
                        </span>
                        <FormControl>
                          <Input
                            {...field}
                            type="number"
                            min="0"
                            max="365"
                            placeholder="30"
                            disabled={!canEdit || isLoading}
                            className="w-24 squircle"
                          />
                        </FormControl>
                        <span className="text-muted-foreground text-sm">
                          days
                        </span>
                      </div>
                      <FormDescription>
                        Number of days clients have to pay after invoicing.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}

            {success && (
              <p className="text-sm text-green-600 dark:text-green-400">
                Settings saved successfully.
              </p>
            )}

            {canEdit && (
              <Button type="submit" disabled={isLoading} className="squircle">
                {isLoading ? "Saving..." : "Save changes"}
              </Button>
            )}

            {!canEdit && (
              <p className="text-sm text-muted-foreground">
                Only owners and admins can update organization settings.
              </p>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

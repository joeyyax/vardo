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

const organizationSettingsSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  defaultRate: z.string(),
  roundingIncrement: z.string(),
});

type OrganizationSettingsFormData = z.infer<typeof organizationSettingsSchema>;

type Organization = {
  id: string;
  name: string;
  slug: string;
  defaultRate: number | null;
  roundingIncrement: number | null;
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
    },
  });

  async function onSubmit(data: OrganizationSettingsFormData) {
    setError(null);
    setSuccess(false);
    setIsLoading(true);

    try {
      // Convert rate from dollars to cents
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
        }),
      });

      if (!response.ok) {
        const responseData = await response.json();
        throw new Error(responseData.error || "Failed to update settings");
      }

      setSuccess(true);
      router.refresh();

      // Clear success message after 3 seconds
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

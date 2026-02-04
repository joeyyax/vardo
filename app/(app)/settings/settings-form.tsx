"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
};

export function SettingsForm({ organization, canEdit }: Props) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form state
  const [name, setName] = useState(organization.name);
  const [defaultRate, setDefaultRate] = useState(
    organization.defaultRate ? (organization.defaultRate / 100).toString() : ""
  );
  const [roundingIncrement, setRoundingIncrement] = useState(
    (organization.roundingIncrement ?? 15).toString()
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(false);

    if (!name.trim()) {
      setError("Organization name is required.");
      return;
    }

    setIsLoading(true);

    try {
      // Convert rate from dollars to cents
      const rateInCents = defaultRate
        ? Math.round(parseFloat(defaultRate) * 100)
        : null;

      const response = await fetch(`/api/v1/organizations/${organization.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          defaultRate: rateInCents,
          roundingIncrement: parseInt(roundingIncrement, 10),
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update settings");
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
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Organization Name */}
          <div className="space-y-2">
            <Label htmlFor="name">Organization name</Label>
            <Input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEdit || isLoading}
              className="max-w-sm squircle"
            />
          </div>

          {/* Default Hourly Rate */}
          <div className="space-y-2">
            <Label htmlFor="defaultRate">Default hourly rate</Label>
            <div className="flex items-center gap-2 max-w-sm">
              <span className="text-muted-foreground">$</span>
              <Input
                id="defaultRate"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={defaultRate}
                onChange={(e) => setDefaultRate(e.target.value)}
                disabled={!canEdit || isLoading}
                className="squircle"
              />
              <span className="text-muted-foreground text-sm whitespace-nowrap">per hour</span>
            </div>
            <p className="text-xs text-muted-foreground">
              This rate is used when clients or projects don&apos;t have their own rate set.
            </p>
          </div>

          {/* Rounding Increment */}
          <div className="space-y-2">
            <Label htmlFor="roundingIncrement">Time rounding</Label>
            <Select
              value={roundingIncrement}
              onValueChange={setRoundingIncrement}
              disabled={!canEdit || isLoading}
            >
              <SelectTrigger id="roundingIncrement" className="max-w-sm squircle">
                <SelectValue placeholder="Select rounding increment" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5 minutes</SelectItem>
                <SelectItem value="10">10 minutes</SelectItem>
                <SelectItem value="15">15 minutes</SelectItem>
                <SelectItem value="30">30 minutes</SelectItem>
                <SelectItem value="60">1 hour</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Time entries will be rounded to the nearest increment.
            </p>
          </div>

          {/* Error Message */}
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          {/* Success Message */}
          {success && (
            <p className="text-sm text-green-600 dark:text-green-400">
              Settings saved successfully.
            </p>
          )}

          {/* Submit Button */}
          {canEdit && (
            <Button
              type="submit"
              disabled={isLoading}
              className="squircle"
            >
              {isLoading ? "Saving..." : "Save changes"}
            </Button>
          )}

          {!canEdit && (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can update organization settings.
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

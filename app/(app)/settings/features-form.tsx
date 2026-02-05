"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Clock, FileText, Kanban, FileSignature } from "lucide-react";
import type { OrgFeatures } from "@/lib/db/schema";

type Props = {
  organizationId: string;
  features: OrgFeatures;
  canEdit: boolean;
};

const FEATURE_CONFIG = [
  {
    key: "time_tracking" as const,
    label: "Time Tracking",
    description: "Track time entries, view timelines, generate reports, and analyze how you spend your time.",
    icon: Clock,
    warning: "Disabling will hide the Track and Reports pages. Your time entries will be preserved.",
  },
  {
    key: "invoicing" as const,
    label: "Invoicing",
    description: "Generate invoices from tracked time, send to clients, and track payments.",
    icon: FileText,
    warning: "Disabling will hide the Invoices page. Your invoices will be preserved.",
  },
  {
    key: "pm" as const,
    label: "Project Management",
    description: "Task boards with statuses (To Do, In Progress, Review, Done), drag-and-drop kanban, and client portal for collaboration.",
    icon: Kanban,
    warning: "Disabling will hide task boards and client portal access. Tasks will become categories for time tracking only.",
  },
  {
    key: "proposals" as const,
    label: "Proposals & Contracts",
    description: "Create professional proposals, generate contracts, and get client signatures - all with AI assistance.",
    icon: FileSignature,
    warning: "Disabling will hide proposal and contract features. Your documents will be preserved.",
  },
];

export function FeaturesForm({ organizationId, features, canEdit }: Props) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Track pending changes
  const [localFeatures, setLocalFeatures] = useState<OrgFeatures>(features);
  const [pendingToggle, setPendingToggle] = useState<keyof OrgFeatures | null>(null);

  const hasChanges = JSON.stringify(localFeatures) !== JSON.stringify(features);

  function handleToggleClick(key: keyof OrgFeatures) {
    // If enabling, just enable
    if (!localFeatures[key]) {
      setLocalFeatures((prev) => ({ ...prev, [key]: true }));
      return;
    }

    // If disabling, show confirmation
    setPendingToggle(key);
  }

  function confirmDisable() {
    if (pendingToggle) {
      setLocalFeatures((prev) => ({ ...prev, [pendingToggle]: false }));
    }
    setPendingToggle(null);
  }

  async function handleSave() {
    setError(null);
    setSuccess(false);
    setIsLoading(true);

    try {
      const response = await fetch(`/api/v1/organizations/${organizationId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ features: localFeatures }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update features");
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

  function handleReset() {
    setLocalFeatures(features);
    setError(null);
    setSuccess(false);
  }

  const pendingFeature = FEATURE_CONFIG.find((f) => f.key === pendingToggle);

  return (
    <>
      <Card className="max-w-2xl squircle">
        <CardHeader>
          <CardTitle>Features</CardTitle>
          <CardDescription>
            Enable or disable features for your organization. Disabled features hide related
            pages and options, but your data is always preserved.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {FEATURE_CONFIG.map((feature) => {
            const Icon = feature.icon;
            const isEnabled = localFeatures[feature.key];

            return (
              <div
                key={feature.key}
                className="flex items-start justify-between gap-4 pb-4 border-b last:border-0 last:pb-0"
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <Icon className="size-5 text-muted-foreground" />
                  </div>
                  <div className="space-y-1">
                    <Label
                      htmlFor={feature.key}
                      className="text-base font-medium cursor-pointer"
                    >
                      {feature.label}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {feature.description}
                    </p>
                  </div>
                </div>
                <Switch
                  id={feature.key}
                  checked={isEnabled}
                  onCheckedChange={() => handleToggleClick(feature.key)}
                  disabled={!canEdit || isLoading}
                />
              </div>
            );
          })}

          {/* Error Message */}
          {error && <p className="text-sm text-destructive">{error}</p>}

          {/* Success Message */}
          {success && (
            <p className="text-sm text-green-600 dark:text-green-400">
              Features updated successfully.
            </p>
          )}

          {/* Action Buttons */}
          {canEdit && hasChanges && (
            <div className="flex gap-2 pt-2">
              <Button
                onClick={handleSave}
                disabled={isLoading}
                className="squircle"
              >
                {isLoading ? "Saving..." : "Save changes"}
              </Button>
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={isLoading}
                className="squircle"
              >
                Reset
              </Button>
            </div>
          )}

          {!canEdit && (
            <p className="text-sm text-muted-foreground">
              Only owners and admins can update organization features.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Confirmation Dialog */}
      <AlertDialog open={!!pendingToggle} onOpenChange={() => setPendingToggle(null)}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Disable {pendingFeature?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingFeature?.warning}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDisable} className="squircle">
              Disable
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

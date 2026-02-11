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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Clock,
  FileText,
  Receipt,
  Kanban,
  FileSignature,
  ArrowRight,
  ArrowLeft,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { OrgFeatures } from "@/lib/db/schema";

type Step = "name" | "features";

const FEATURE_OPTIONS = [
  {
    key: "time_tracking" as const,
    label: "Time Tracking",
    description: "Track time entries, view timelines, and generate reports",
    icon: Clock,
    defaultEnabled: true,
  },
  {
    key: "invoicing" as const,
    label: "Invoicing",
    description: "Generate invoices from tracked time, send to clients",
    icon: FileText,
    defaultEnabled: true,
  },
  {
    key: "expenses" as const,
    label: "Expense Tracking",
    description: "Track business expenses, attach receipts, categorize spending",
    icon: Receipt,
    defaultEnabled: true,
  },
  {
    key: "pm" as const,
    label: "Project Management",
    description: "Task boards, statuses, client portal for collaboration",
    icon: Kanban,
    defaultEnabled: false,
  },
  {
    key: "proposals" as const,
    label: "Proposals & Contracts",
    description: "Create proposals, generate contracts, get client signatures",
    icon: FileSignature,
    defaultEnabled: false,
  },
] as const;

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [features, setFeatures] = useState<OrgFeatures>({
    time_tracking: true,
    invoicing: true,
    expenses: true,
    pm: false,
    proposals: false,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate slug preview from name
  const slugPreview = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  function handleFeatureToggle(key: keyof OrgFeatures) {
    setFeatures((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }

  function handleNext() {
    if (step === "name") {
      if (!name.trim()) {
        setError("Please enter an organization name.");
        return;
      }
      setError(null);
      setStep("features");
    }
  }

  function handleBack() {
    if (step === "features") {
      setStep("name");
    }
  }

  async function handleSubmit() {
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch("/api/v1/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: name.trim(),
          features,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create organization");
      }

      // Success - redirect to appropriate page based on features
      if (features.time_tracking) {
        router.push("/track");
      } else {
        router.push("/projects");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  // Count enabled features for summary
  const enabledCount = Object.values(features).filter(Boolean).length;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-lg squircle">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">
            {step === "name" ? "Welcome to Time" : "What do you need?"}
          </CardTitle>
          <CardDescription>
            {step === "name"
              ? "Let's set up your workspace. You can always change this later."
              : "Enable the features you need. You can change this anytime in settings."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {step === "name" && (
            <div className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="name">Organization name</Label>
                <Input
                  id="name"
                  type="text"
                  placeholder="Acme Inc."
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={isLoading}
                  autoFocus
                  className="squircle"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleNext();
                    }
                  }}
                />
                {slugPreview && (
                  <p className="text-xs text-muted-foreground">
                    Your workspace URL will include: {slugPreview}
                  </p>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                onClick={handleNext}
                className="w-full squircle"
                disabled={!name.trim()}
              >
                Continue
                <ArrowRight className="ml-2 size-4" />
              </Button>
            </div>
          )}

          {step === "features" && (
            <div className="space-y-6">
              <div className="space-y-3">
                {FEATURE_OPTIONS.map((feature) => {
                  const Icon = feature.icon;
                  const isEnabled = features[feature.key];

                  return (
                    <div
                      key={feature.key}
                      className={cn(
                        "flex items-start gap-4 rounded-lg border p-4 cursor-pointer transition-colors squircle",
                        isEnabled
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-muted-foreground/50"
                      )}
                      onClick={() => handleFeatureToggle(feature.key)}
                    >
                      <Checkbox
                        id={feature.key}
                        checked={isEnabled}
                        onCheckedChange={() => handleFeatureToggle(feature.key)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Icon className="size-4 text-muted-foreground" />
                          <Label
                            htmlFor={feature.key}
                            className="font-medium cursor-pointer"
                          >
                            {feature.label}
                          </Label>
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {feature.description}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>

              {enabledCount === 0 && (
                <p className="text-sm text-amber-600 dark:text-amber-400">
                  Select at least one feature to get started.
                </p>
              )}

              {error && <p className="text-sm text-destructive">{error}</p>}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  onClick={handleBack}
                  className="squircle"
                  disabled={isLoading}
                >
                  <ArrowLeft className="mr-2 size-4" />
                  Back
                </Button>
                <Button
                  onClick={handleSubmit}
                  className="flex-1 squircle"
                  disabled={isLoading || enabledCount === 0}
                >
                  {isLoading ? (
                    "Creating..."
                  ) : (
                    <>
                      <Check className="mr-2 size-4" />
                      Create workspace
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { CheckCircle2, ClipboardList, Loader2 } from "lucide-react";
import { ONBOARDING_CATEGORY_LABELS } from "@/lib/onboarding-templates";
import type { OnboardingCategory } from "@/lib/db/schema";

type OnboardingItem = {
  id: string;
  projectId: string;
  label: string;
  description: string | null;
  category: OnboardingCategory;
  isRequired: boolean;
  isCompleted: boolean;
  completedAt: string | null;
  position: number;
};

type ProjectOnboardingChecklistProps = {
  orgId: string;
  projectId: string;
  onComplete: () => void;
};

export function ProjectOnboardingChecklist({
  orgId,
  projectId,
  onComplete,
}: ProjectOnboardingChecklistProps) {
  const [items, setItems] = useState<OnboardingItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCompleting, setIsCompleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/onboarding`
      );
      if (res.ok) {
        const data = await res.json();
        if (data.length === 0) {
          // Initialize from template
          const initRes = await fetch(
            `/api/v1/organizations/${orgId}/projects/${projectId}/onboarding`,
            { method: "POST" }
          );
          if (initRes.ok) {
            const initialized = await initRes.json();
            setItems(initialized);
          }
        } else {
          setItems(data);
        }
      }
    } catch (err) {
      console.error("Error fetching onboarding items:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const toggleItem = async (itemId: string, isCompleted: boolean) => {
    setTogglingId(itemId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/onboarding/${itemId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ isCompleted }),
        }
      );

      if (res.ok) {
        const updated = await res.json();
        setItems((prev) =>
          prev.map((item) => (item.id === itemId ? updated : item))
        );
      }
    } catch (err) {
      console.error("Error toggling item:", err);
    } finally {
      setTogglingId(null);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/onboarding/complete`,
        { method: "POST" }
      );

      if (res.ok) {
        toast.success("Onboarding complete", {
          description: "The project is now active. Time to get to work.",
        });
        onComplete();
      } else {
        const data = await res.json();
        toast.error("Cannot complete onboarding", {
          description: data.error,
        });
      }
    } catch (err) {
      console.error("Error completing onboarding:", err);
      toast.error("Something went wrong");
    } finally {
      setIsCompleting(false);
    }
  };

  // Group items by category
  const grouped = items.reduce<Record<string, OnboardingItem[]>>(
    (acc, item) => {
      const key = item.category;
      if (!acc[key]) acc[key] = [];
      acc[key].push(item);
      return acc;
    },
    {}
  );

  const totalItems = items.length;
  const completedItems = items.filter((i) => i.isCompleted).length;
  const requiredItems = items.filter((i) => i.isRequired);
  const allRequiredComplete = requiredItems.every((i) => i.isCompleted);
  const progressPercent = totalItems > 0 ? (completedItems / totalItems) * 100 : 0;

  if (isLoading) {
    return (
      <Card className="squircle">
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <ClipboardList className="size-5" />
          Onboarding Checklist
        </CardTitle>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {completedItems}/{totalItems} complete
          </span>
          <Button
            size="sm"
            className="squircle"
            disabled={!allRequiredComplete || isCompleting}
            onClick={handleComplete}
          >
            {isCompleting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            Mark Onboarding Complete
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Progress bar */}
        <div className="space-y-1.5">
          <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          {!allRequiredComplete && (
            <p className="text-xs text-muted-foreground">
              Complete all required items to advance to active.
            </p>
          )}
        </div>

        {/* Grouped checklist items */}
        {Object.entries(grouped).map(([category, categoryItems]) => (
          <div key={category} className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">
              {ONBOARDING_CATEGORY_LABELS[category as OnboardingCategory] ??
                category}
            </h3>
            <div className="space-y-2">
              {categoryItems.map((item) => (
                <label
                  key={item.id}
                  className="flex items-start gap-3 p-3 rounded-lg border hover:bg-accent/50 transition-colors cursor-pointer"
                >
                  <Checkbox
                    checked={item.isCompleted}
                    disabled={togglingId === item.id}
                    onCheckedChange={(checked) =>
                      toggleItem(item.id, checked === true)
                    }
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span
                        className={
                          item.isCompleted
                            ? "line-through text-muted-foreground"
                            : "font-medium"
                        }
                      >
                        {item.label}
                      </span>
                      {item.isRequired && (
                        <span className="text-[10px] uppercase tracking-wider text-amber-600 dark:text-amber-400 font-medium">
                          Required
                        </span>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">
                        {item.description}
                      </p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

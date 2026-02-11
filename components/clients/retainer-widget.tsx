"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Timer, AlertTriangle, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

type RetainerStatus = {
  billingType: string | null;
  retainerAmount: number | null;
  overageRate: number | null;
  includedMinutes: number;
  usedMinutes: number;
  rolloverMinutes: number;
  totalAvailable: number;
  remainingMinutes: number;
  overageMinutes: number;
  usagePercent: number;
  periodStart: string | null;
  periodEnd: string | null;
  hasActivePeriod: boolean;
};

type RetainerWidgetProps = {
  orgId: string;
  clientId: string;
  billingType: string | null;
};

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  if (hours === 0) return "0h";
  if (hours < 1) return `${minutes}m`;
  return `${hours.toFixed(1)}h`;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T00:00:00");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function getBillingLabel(type: string | null): string {
  switch (type) {
    case "retainer_fixed":
      return "Fixed Retainer";
    case "retainer_capped":
      return "Capped Retainer";
    case "retainer_uncapped":
      return "Uncapped Retainer";
    default:
      return "Retainer";
  }
}

export function RetainerWidget({
  orgId,
  clientId,
  billingType,
}: RetainerWidgetProps) {
  const [status, setStatus] = useState<RetainerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchRetainerStatus() {
      try {
        const res = await fetch(
          `/api/v1/organizations/${orgId}/clients/${clientId}/retainer`
        );
        if (res.ok) {
          setStatus(await res.json());
        }
      } catch (err) {
        console.error("Error fetching retainer status:", err);
      } finally {
        setIsLoading(false);
      }
    }

    if (
      billingType === "retainer_fixed" ||
      billingType === "retainer_capped" ||
      billingType === "retainer_uncapped"
    ) {
      fetchRetainerStatus();
    } else {
      setIsLoading(false);
    }
  }, [orgId, clientId, billingType]);

  if (isLoading || !status) return null;

  const isOverage = status.overageMinutes > 0;
  const isNearLimit = status.usagePercent >= 80 && !isOverage;

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer className="size-4" />
          {getBillingLabel(billingType)}
        </CardTitle>
        <div className="flex items-center gap-2">
          {status.retainerAmount && (
            <Badge variant="outline" className="text-xs">
              {formatCurrency(status.retainerAmount)}/mo
            </Badge>
          )}
          {status.hasActivePeriod && status.periodStart && status.periodEnd && (
            <Badge variant="secondary" className="text-xs">
              {formatDate(status.periodStart)} – {formatDate(status.periodEnd)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              {formatHours(status.usedMinutes)} used
            </span>
            <span className="text-muted-foreground">
              {formatHours(status.totalAvailable)} available
            </span>
          </div>
          <Progress
            value={Math.min(status.usagePercent, 100)}
            className={cn(
              "h-3",
              isOverage && "[&>div]:bg-red-500",
              isNearLimit && "[&>div]:bg-amber-500"
            )}
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{status.usagePercent}% used</span>
            {status.rolloverMinutes > 0 && (
              <span className="flex items-center gap-1">
                <TrendingUp className="size-3" />
                {formatHours(status.rolloverMinutes)} rollover
              </span>
            )}
          </div>
        </div>

        {/* Status indicators */}
        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="text-lg font-semibold tabular-nums">
              {formatHours(status.includedMinutes)}
            </p>
            <p className="text-xs text-muted-foreground">Included</p>
          </div>
          <div className="rounded-lg bg-muted/50 p-2.5">
            <p className="text-lg font-semibold tabular-nums">
              {formatHours(status.remainingMinutes)}
            </p>
            <p className="text-xs text-muted-foreground">Remaining</p>
          </div>
          <div
            className={cn(
              "rounded-lg p-2.5",
              isOverage
                ? "bg-red-50 dark:bg-red-950"
                : "bg-muted/50"
            )}
          >
            <p
              className={cn(
                "text-lg font-semibold tabular-nums",
                isOverage && "text-red-600 dark:text-red-400"
              )}
            >
              {formatHours(status.overageMinutes)}
            </p>
            <p className="text-xs text-muted-foreground">Overage</p>
          </div>
        </div>

        {/* Warnings */}
        {isOverage && status.overageRate && (
          <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-800 dark:bg-red-950">
            <AlertTriangle className="size-4 text-red-500 shrink-0" />
            <span className="text-red-700 dark:text-red-300">
              {formatHours(status.overageMinutes)} over limit at{" "}
              {formatCurrency(status.overageRate)}/hr
            </span>
          </div>
        )}
        {isNearLimit && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <AlertTriangle className="size-4 text-amber-500 shrink-0" />
            <span className="text-amber-700 dark:text-amber-300">
              Approaching retainer limit — {formatHours(status.remainingMinutes)} remaining
            </span>
          </div>
        )}

        {!status.hasActivePeriod && (
          <p className="text-xs text-muted-foreground text-center">
            No active billing period. A period will be created when the next invoice is generated.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

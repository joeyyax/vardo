"use client";

import { useState, useCallback } from "react";
import { format, parseISO, startOfWeek, endOfWeek, addWeeks, subWeeks } from "date-fns";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, DollarSign, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type ReportEntry = {
  id: string;
  description: string | null;
  minutes: number;
  project: string | null;
  task: string | null;
  amount?: number;
};

type DateGroup = {
  date: string;
  entries: ReportEntry[];
  totalMinutes: number;
};

type ReportData = {
  report: {
    title: string;
    subtitle: string | null;
    organizationName: string;
    showRates: boolean;
    periodStart: string;
    periodEnd: string;
  };
  summary: {
    totalMinutes: number;
    totalHours: string;
    totalBillable?: number;
    entryCount: number;
  };
  entriesByDate: DateGroup[];
};

type PublicReportContentProps = {
  slug: string;
  initialData: ReportData;
};

function formatHours(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

function formatCurrency(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

export function PublicReportContent({ slug, initialData }: PublicReportContentProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [data, setData] = useState<ReportData>(initialData);
  const [isLoading, setIsLoading] = useState(false);

  const currentFrom = searchParams.get("from") || data.report.periodStart;

  const navigateWeek = useCallback(
    async (direction: "prev" | "next") => {
      setIsLoading(true);
      const currentStart = parseISO(currentFrom);
      const newStart =
        direction === "prev"
          ? startOfWeek(subWeeks(currentStart, 1), { weekStartsOn: 1 })
          : startOfWeek(addWeeks(currentStart, 1), { weekStartsOn: 1 });
      const newEnd = endOfWeek(newStart, { weekStartsOn: 1 });

      const from = format(newStart, "yyyy-MM-dd");
      const to = format(newEnd, "yyyy-MM-dd");

      try {
        const response = await fetch(`/api/reports/${slug}?from=${from}&to=${to}`);
        if (response.ok) {
          const newData = await response.json();
          setData(newData);
          router.push(`/r/${slug}?from=${from}&to=${to}`, { scroll: false });
        }
      } catch (err) {
        console.error("Failed to navigate:", err);
      } finally {
        setIsLoading(false);
      }
    },
    [slug, currentFrom, router]
  );

  const goToToday = useCallback(async () => {
    setIsLoading(true);
    const now = new Date();
    const from = format(startOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd");
    const to = format(endOfWeek(now, { weekStartsOn: 1 }), "yyyy-MM-dd");

    try {
      const response = await fetch(`/api/reports/${slug}?from=${from}&to=${to}`);
      if (response.ok) {
        const newData = await response.json();
        setData(newData);
        router.push(`/r/${slug}?from=${from}&to=${to}`, { scroll: false });
      }
    } catch (err) {
      console.error("Failed to navigate:", err);
    } finally {
      setIsLoading(false);
    }
  }, [slug, router]);

  const formatDateRange = () => {
    const start = parseISO(data.report.periodStart);
    const end = parseISO(data.report.periodEnd);
    return `${format(start, "MMM d")} - ${format(end, "MMM d, yyyy")}`;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card">
        <div className="container mx-auto max-w-4xl px-4 py-8">
          <div className="text-sm text-muted-foreground mb-2">
            {data.report.organizationName}
          </div>
          <h1 className="text-3xl font-bold">{data.report.title}</h1>
          {data.report.subtitle && (
            <p className="text-lg text-muted-foreground mt-1">
              {data.report.subtitle}
            </p>
          )}
        </div>
      </div>

      <div className="container mx-auto max-w-4xl px-4 py-8 space-y-8">
        {/* Week Navigation */}
        <div className="flex items-center justify-between">
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigateWeek("prev")}
            disabled={isLoading}
            className="squircle"
          >
            <ChevronLeft className="size-4" />
          </Button>

          <div className="flex items-center gap-4">
            <span className="text-lg font-medium">{formatDateRange()}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={goToToday}
              disabled={isLoading}
              className="squircle"
            >
              This Week
            </Button>
          </div>

          <Button
            variant="outline"
            size="icon"
            onClick={() => navigateWeek("next")}
            disabled={isLoading}
            className="squircle"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>

        {/* Summary Cards */}
        <div className={`grid gap-4 ${data.report.showRates ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Time</CardTitle>
              <Clock className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {formatHours(data.summary.totalMinutes)}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.summary.entryCount} entries
              </p>
            </CardContent>
          </Card>

          {data.report.showRates && data.summary.totalBillable !== undefined && (
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Amount</CardTitle>
                <DollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCurrency(data.summary.totalBillable)}
                </div>
                <p className="text-xs text-muted-foreground">Billable</p>
              </CardContent>
            </Card>
          )}

          <Card className="squircle">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Daily Average</CardTitle>
              <FileText className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {data.entriesByDate.length > 0
                  ? formatHours(
                      Math.round(data.summary.totalMinutes / data.entriesByDate.length)
                    )
                  : "0h"}
              </div>
              <p className="text-xs text-muted-foreground">
                {data.entriesByDate.length} days with activity
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Entries by Date */}
        {data.entriesByDate.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-muted-foreground">No time entries for this period.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {data.entriesByDate.map((group) => (
              <div key={group.date} className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-medium">
                    {format(parseISO(group.date), "EEEE, MMMM d")}
                  </h3>
                  <span className="text-sm text-muted-foreground">
                    {formatHours(group.totalMinutes)}
                  </span>
                </div>

                <div className="rounded-lg border divide-y">
                  {group.entries.map((entry) => (
                    <div
                      key={entry.id}
                      className="p-4 flex items-center justify-between gap-4"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">
                          {entry.description || "No description"}
                        </div>
                        {(entry.project || entry.task) && (
                          <div className="text-sm text-muted-foreground truncate">
                            {[entry.project, entry.task].filter(Boolean).join(" / ")}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-4 shrink-0">
                        <span className="text-sm tabular-nums">
                          {formatHours(entry.minutes)}
                        </span>
                        {data.report.showRates && entry.amount !== undefined && (
                          <span className="text-sm text-muted-foreground tabular-nums">
                            {formatCurrency(entry.amount)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Print-friendly footer */}
        <div className="text-center text-sm text-muted-foreground pt-8 border-t print:block hidden">
          Generated by {data.report.organizationName}
        </div>
      </div>
    </div>
  );
}

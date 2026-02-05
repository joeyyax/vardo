"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Clock, DollarSign, TrendingUp, Users } from "lucide-react";

type AnalyticsPeriod = "week" | "month" | "quarter" | "year";

type ClientSummary = {
  id: string;
  name: string;
  color: string | null;
  totalMinutes: number;
  totalAmount: number;
};

type Analytics = {
  totalMinutes: number;
  totalBillable: number; // cents
  uniqueClients: number;
  averageHoursPerDay: number;
  clientBreakdown: ClientSummary[];
};

type ReportsContentProps = {
  orgId: string;
};

export function ReportsContent({ orgId }: ReportsContentProps) {
  const [period, setPeriod] = useState<AnalyticsPeriod>("month");
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalytics = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/analytics?period=${period}`
      );
      if (!response.ok) {
        if (response.status === 404) {
          // Endpoint not yet implemented
          setAnalytics(null);
          return;
        }
        throw new Error("Failed to fetch analytics");
      }
      const data = await response.json();
      setAnalytics(data);
    } catch (err) {
      console.error("Error fetching analytics:", err);
      setError("Failed to load analytics");
    } finally {
      setIsLoading(false);
    }
  }, [orgId, period]);

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const formatHours = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  };

  const formatCurrency = (cents: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(cents / 100);
  };

  return (
    <div className="space-y-6">
      {/* Period selector */}
      <div className="flex items-center gap-4">
        <Select
          value={period}
          onValueChange={(value) => setPeriod(value as AnalyticsPeriod)}
        >
          <SelectTrigger className="squircle w-[180px]">
            <SelectValue placeholder="Select period" />
          </SelectTrigger>
          <SelectContent className="squircle">
            <SelectItem value="week">This Week</SelectItem>
            <SelectItem value="month">This Month</SelectItem>
            <SelectItem value="quarter">This Quarter</SelectItem>
            <SelectItem value="year">This Year</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
        </div>
      ) : !analytics ? (
        <div className="py-12 text-center">
          <p className="text-muted-foreground">
            Analytics will be available once you have tracked time.
          </p>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Total Time
                </CardTitle>
                <Clock className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatHours(analytics.totalMinutes)}
                </div>
                <p className="text-xs text-muted-foreground">
                  {(analytics.totalMinutes / 60).toFixed(1)} hours
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Billable Amount
                </CardTitle>
                <DollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {formatCurrency(analytics.totalBillable)}
                </div>
                <p className="text-xs text-muted-foreground">
                  Before any adjustments
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Active Clients
                </CardTitle>
                <Users className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {analytics.uniqueClients}
                </div>
                <p className="text-xs text-muted-foreground">
                  With tracked time
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Avg Hours/Day
                </CardTitle>
                <TrendingUp className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {analytics.averageHoursPerDay.toFixed(1)}h
                </div>
                <p className="text-xs text-muted-foreground">
                  Per working day
                </p>
              </CardContent>
            </Card>
          </div>

          {/* Client breakdown */}
          {analytics.clientBreakdown.length > 0 && (
            <Card className="squircle">
              <CardHeader>
                <CardTitle>Hours by Client</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analytics.clientBreakdown.map((client) => {
                    const percentage =
                      analytics.totalMinutes > 0
                        ? (client.totalMinutes / analytics.totalMinutes) * 100
                        : 0;
                    return (
                      <div key={client.id} className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <div className="flex items-center gap-2">
                            <div
                              className="size-3 rounded-full"
                              style={{
                                backgroundColor: client.color || "#94a3b8",
                              }}
                            />
                            <span className="font-medium">{client.name}</span>
                          </div>
                          <div className="flex items-center gap-4 text-muted-foreground">
                            <span>{formatHours(client.totalMinutes)}</span>
                            <span className="w-12 text-right">
                              {percentage.toFixed(0)}%
                            </span>
                          </div>
                        </div>
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${percentage}%`,
                              backgroundColor: client.color || "#94a3b8",
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

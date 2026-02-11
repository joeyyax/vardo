"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Activity,
  Clock,
  AlertTriangle,
  Gauge,
  Loader2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

type HealthData = {
  summary: {
    uptimePercent: number;
    avgLoadMs: number;
    avgTtfbMs: number;
    errorRate: number;
    totalPageviews: number;
    vitals: {
      lcp: number | null;
      cls: number | null;
      inp: number | null;
    };
  };
  timeseries: Array<{
    date: string;
    pageviews: number;
    avgLoadMs: number;
    avgTtfbMs: number;
    errorCount: number;
    avgLcp: number | null;
    avgCls: number | null;
  }>;
  topPages: Array<{
    pageUrl: string;
    views: number;
    avgLoadMs: number;
    errorCount: number;
  }>;
  recentErrors: Array<{
    pageUrl: string;
    timestamp: string;
    jsErrors: number;
    consoleErrors: number;
    resourceFailures: number;
  }>;
};

type ScopeClientHealthProps = {
  scopeClientId: string;
  scopeClientName: string;
  orgId: string;
};

function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  status,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  subtitle?: string;
  status?: "good" | "warning" | "bad";
}) {
  const statusColors = {
    good: "text-green-600 dark:text-green-400",
    warning: "text-yellow-600 dark:text-yellow-400",
    bad: "text-red-600 dark:text-red-400",
  };

  return (
    <Card className="squircle">
      <CardContent className="pt-6">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2">
            <Icon className="size-5 text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p
              className={`text-2xl font-bold ${status ? statusColors[status] : ""}`}
            >
              {value}
            </p>
            {subtitle && (
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function getUptimeStatus(pct: number): "good" | "warning" | "bad" {
  if (pct >= 99) return "good";
  if (pct >= 95) return "warning";
  return "bad";
}

function getLoadStatus(ms: number): "good" | "warning" | "bad" {
  if (ms < 2000) return "good";
  if (ms < 4000) return "warning";
  return "bad";
}

function getVitalStatus(
  type: "lcp" | "cls" | "inp",
  value: number | null
): "good" | "warning" | "bad" {
  if (value === null) return "good";
  const thresholds = {
    lcp: { good: 2500, warning: 4000 },
    cls: { good: 0.1, warning: 0.25 },
    inp: { good: 200, warning: 500 },
  };
  const t = thresholds[type];
  if (value <= t.good) return "good";
  if (value <= t.warning) return "warning";
  return "bad";
}

function formatMs(ms: number | null): string {
  if (ms === null || ms === 0) return "N/A";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ScopeClientHealth({
  scopeClientId,
  scopeClientName,
  orgId,
}: ScopeClientHealthProps) {
  const [period, setPeriod] = useState("7d");
  const [data, setData] = useState<HealthData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const fetchHealth = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/scope-clients/${scopeClientId}/health?period=${period}`
      );
      if (res.ok) {
        setData(await res.json());
      }
    } catch (err) {
      console.error("Error fetching health data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, scopeClientId, period]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data || data.summary.totalPageviews === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No monitoring data yet for {scopeClientName}.
      </p>
    );
  }

  const { summary, timeseries, topPages, recentErrors } = data;

  const chartData = timeseries.map((t) => ({
    ...t,
    date: formatDateLabel(t.date),
    avgLoadMs: Math.round(t.avgLoadMs ?? 0),
    avgTtfbMs: Math.round(t.avgTtfbMs ?? 0),
    avgLcp: t.avgLcp ? Math.round(t.avgLcp) : null,
  }));

  const bestVitalStatus = (() => {
    const statuses = [
      getVitalStatus("lcp", summary.vitals.lcp),
      getVitalStatus("cls", summary.vitals.cls),
      getVitalStatus("inp", summary.vitals.inp),
    ];
    if (statuses.includes("bad")) return "bad";
    if (statuses.includes("warning")) return "warning";
    return "good";
  })();

  const vitalsLabel = [
    summary.vitals.lcp ? `LCP ${formatMs(summary.vitals.lcp)}` : null,
    summary.vitals.cls !== null ? `CLS ${summary.vitals.cls}` : null,
    summary.vitals.inp ? `INP ${formatMs(summary.vitals.inp)}` : null,
  ]
    .filter(Boolean)
    .join(" / ") || "N/A";

  return (
    <div className="space-y-4">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{scopeClientName}</h3>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger className="squircle w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">7 days</SelectItem>
            <SelectItem value="30d">30 days</SelectItem>
            <SelectItem value="90d">90 days</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Activity}
          label="Uptime"
          value={`${summary.uptimePercent}%`}
          subtitle={`${summary.totalPageviews} pageviews`}
          status={getUptimeStatus(summary.uptimePercent)}
        />
        <StatCard
          icon={Clock}
          label="Avg Load Time"
          value={formatMs(summary.avgLoadMs)}
          subtitle={`TTFB ${formatMs(summary.avgTtfbMs)}`}
          status={getLoadStatus(summary.avgLoadMs)}
        />
        <StatCard
          icon={AlertTriangle}
          label="Error Rate"
          value={`${summary.errorRate}/pv`}
          subtitle="Errors per pageview"
        />
        <StatCard
          icon={Gauge}
          label="Core Web Vitals"
          value={summary.vitals.lcp ? formatMs(summary.vitals.lcp) : "N/A"}
          subtitle={vitalsLabel}
          status={bestVitalStatus}
        />
      </div>

      {/* Charts */}
      {chartData.length > 1 && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Load time trend */}
          <Card className="squircle">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Load Time Trend
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 11 }} />
                  <YAxis className="text-xs" tick={{ fontSize: 11 }} unit="ms" />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="avgLoadMs"
                    name="Load"
                    stroke="hsl(var(--primary))"
                    fill="hsl(var(--primary))"
                    fillOpacity={0.1}
                  />
                  <Area
                    type="monotone"
                    dataKey="avgTtfbMs"
                    name="TTFB"
                    stroke="hsl(var(--muted-foreground))"
                    fill="hsl(var(--muted-foreground))"
                    fillOpacity={0.05}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Pageviews + errors */}
          <Card className="squircle">
            <CardHeader>
              <CardTitle className="text-sm font-medium">
                Pageviews & Errors
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" className="text-xs" tick={{ fontSize: 11 }} />
                  <YAxis className="text-xs" tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="pageviews" name="Pageviews" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="errorCount" name="Errors" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Top pages table */}
      {topPages.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top Pages</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead className="text-right">Views</TableHead>
                  <TableHead className="text-right">Avg Load</TableHead>
                  <TableHead className="text-right">Errors</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topPages.slice(0, 10).map((page, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs max-w-[300px] truncate">
                      {(() => {
                        try {
                          return new URL(page.pageUrl).pathname;
                        } catch {
                          return page.pageUrl;
                        }
                      })()}
                    </TableCell>
                    <TableCell className="text-right">{page.views}</TableCell>
                    <TableCell className="text-right">
                      {formatMs(Math.round(page.avgLoadMs ?? 0))}
                    </TableCell>
                    <TableCell className="text-right">{page.errorCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Recent errors */}
      {recentErrors.length > 0 && (
        <Card className="squircle">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Recent Errors</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Page</TableHead>
                  <TableHead>Time</TableHead>
                  <TableHead className="text-right">JS</TableHead>
                  <TableHead className="text-right">Console</TableHead>
                  <TableHead className="text-right">Resources</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentErrors.slice(0, 10).map((err, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs max-w-[200px] truncate">
                      {(() => {
                        try {
                          return new URL(err.pageUrl).pathname;
                        } catch {
                          return err.pageUrl;
                        }
                      })()}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(err.timestamp).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </TableCell>
                    <TableCell className="text-right">{err.jsErrors}</TableCell>
                    <TableCell className="text-right">{err.consoleErrors}</TableCell>
                    <TableCell className="text-right">{err.resourceFailures}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

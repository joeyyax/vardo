"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  Edit,
  Plus,
  Clock,
  DollarSign,
  FileText,
  FolderKanban,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ClientDialog } from "@/components/clients/client-dialog";
import { ProjectDialog } from "@/components/projects/project-dialog";

// Server-side types (Date objects from DB)
type ServerClient = {
  id: string;
  organizationId: string;
  name: string;
  color: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  parentClientId: string | null;
  billingType: string | null;
  billingFrequency: string | null;
  autoGenerateInvoices: boolean | null;
  retainerAmount: number | null;
  billingDayOfWeek: number | null;
  billingDayOfMonth: number | null;
  paymentTermsDays: number | null;
  lastInvoicedDate: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ServerProject = {
  id: string;
  clientId: string;
  name: string;
  code: string | null;
  rateOverride: number | null;
  isBillable: boolean | null;
  isArchived: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

type ClientWithProjects = ServerClient & {
  projects: ServerProject[];
};

type ClientStats = {
  totalMinutes: number;
  totalMinutesAllTime: number;
  totalBillable: number;
  totalBillableAllTime: number;
  outstandingInvoices: number;
  pendingAmount: number;
};

type RecentEntry = {
  id: string;
  date: string;
  description: string | null;
  durationMinutes: number;
  project: { id: string; name: string } | null;
  task: { id: string; name: string } | null;
};

type OutstandingInvoice = {
  id: string;
  invoiceNumber: string;
  periodStart: string;
  periodEnd: string;
  subtotal: number;
  status: string | null;
  createdAt: string;
};

type ClientDashboardProps = {
  client: ClientWithProjects;
  orgId: string;
};

// Convert server types to client-side types with string dates
// Handles both Date objects (from server) and strings (from JSON/props)
function toClientType(serverClient: ServerClient | ClientWithProjects) {
  const createdAt = serverClient.createdAt instanceof Date
    ? serverClient.createdAt.toISOString()
    : String(serverClient.createdAt);
  const updatedAt = serverClient.updatedAt instanceof Date
    ? serverClient.updatedAt.toISOString()
    : String(serverClient.updatedAt);

  return {
    ...serverClient,
    createdAt,
    updatedAt,
  };
}

export function ClientDashboard({ client: initialClient, orgId }: ClientDashboardProps) {
  const [client, setClient] = useState(initialClient);
  const [allClients, setAllClients] = useState<ClientWithProjects[]>([]);
  const [stats, setStats] = useState<ClientStats | null>(null);
  const [recentEntries, setRecentEntries] = useState<RecentEntry[]>([]);
  const [invoices, setInvoices] = useState<OutstandingInvoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [statsRes, entriesRes, invoicesRes, clientsRes] = await Promise.all([
        fetch(`/api/v1/organizations/${orgId}/clients/${client.id}/stats`),
        fetch(`/api/v1/organizations/${orgId}/clients/${client.id}/entries?limit=10`),
        fetch(`/api/v1/organizations/${orgId}/invoices?clientId=${client.id}&status=draft,sent`),
        fetch(`/api/v1/organizations/${orgId}/clients`),
      ]);

      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
      }

      if (entriesRes.ok) {
        const entriesData = await entriesRes.json();
        setRecentEntries(entriesData.entries || []);
      }

      if (invoicesRes.ok) {
        const invoicesData = await invoicesRes.json();
        setInvoices(invoicesData.invoices || []);
      }

      if (clientsRes.ok) {
        const clientsData = await clientsRes.json();
        setAllClients(clientsData || []);
      }
    } catch (err) {
      console.error("Error fetching client data:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, client.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleClientUpdated = useCallback(async () => {
    // Refresh client data
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients/${client.id}`);
      if (response.ok) {
        const data = await response.json();
        setClient((prev) => ({ ...prev, ...data }));
      }
    } catch (err) {
      console.error("Error refreshing client:", err);
    }
    fetchData();
  }, [orgId, client.id, fetchData]);

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

  const getBillingTypeLabel = (type: string | null) => {
    switch (type) {
      case "hourly":
        return "Hourly";
      case "retainer_fixed":
        return "Fixed Retainer";
      case "retainer_capped":
        return "Capped Retainer";
      case "retainer_uncapped":
        return "Uncapped Retainer";
      case "fixed_project":
        return "Fixed Project";
      default:
        return "Hourly (default)";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link href="/clients">
            <Button variant="ghost" size="icon" className="squircle">
              <ArrowLeft className="size-4" />
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div
              className="size-4 rounded-full ring-2 ring-offset-2 ring-border"
              style={{ backgroundColor: client.color || "#94a3b8" }}
            />
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {client.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {getBillingTypeLabel(client.billingType)}
                {client.billingFrequency &&
                  ` \u2022 ${client.billingFrequency.charAt(0).toUpperCase() + client.billingFrequency.slice(1)}`}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setEditDialogOpen(true)}
            className="squircle"
          >
            <Edit className="size-4" />
            Edit
          </Button>
          <Button
            onClick={() => setProjectDialogOpen(true)}
            className="squircle"
          >
            <Plus className="size-4" />
            New Project
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Stats cards */}
          <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">This Month</CardTitle>
                <Clock className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatHours(stats.totalMinutes) : "0h"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {stats ? `${(stats.totalMinutes / 60).toFixed(1)} hours tracked` : "No time tracked"}
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">All Time</CardTitle>
                <Clock className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatHours(stats.totalMinutesAllTime) : "0h"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Total hours tracked
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Revenue (Month)</CardTitle>
                <DollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatCurrency(stats.totalBillable) : "$0"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Billable this month
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Revenue (All Time)</CardTitle>
                <DollarSign className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatCurrency(stats.totalBillableAllTime) : "$0"}
                </div>
                <p className="text-xs text-muted-foreground">
                  Total billable revenue
                </p>
              </CardContent>
            </Card>

            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Outstanding</CardTitle>
                <FileText className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? formatCurrency(stats.pendingAmount) : "$0"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {stats?.outstandingInvoices || 0} pending invoice(s)
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Active Projects */}
            <Card className="squircle">
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <FolderKanban className="size-5" />
                  Active Projects
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setProjectDialogOpen(true)}
                  className="squircle"
                >
                  <Plus className="size-4" />
                  Add
                </Button>
              </CardHeader>
              <CardContent>
                {client.projects.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No active projects. Create one to start tracking time.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {client.projects.map((project) => (
                      <Link
                        key={project.id}
                        href={`/projects/${project.id}`}
                        className="squircle flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{project.name}</span>
                          {project.code && (
                            <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                              {project.code}
                            </span>
                          )}
                        </div>
                        {project.rateOverride && (
                          <span className="text-sm text-muted-foreground">
                            ${(project.rateOverride / 100).toFixed(2)}/hr
                          </span>
                        )}
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Entries */}
            <Card className="squircle">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="size-5" />
                  Recent Entries
                </CardTitle>
              </CardHeader>
              <CardContent>
                {recentEntries.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No time entries yet.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {recentEntries.map((entry) => (
                      <Link
                        key={entry.id}
                        href={`/track?date=${entry.date}&entry=${entry.id}`}
                        className="flex items-start justify-between gap-4 text-sm hover:bg-muted/50 -mx-2 px-2 py-1 rounded-md transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(entry.date + "T12:00:00"), "MMM d")}
                            </span>
                            {entry.project && (
                              <span className="text-xs bg-muted px-1.5 py-0.5 rounded truncate">
                                {entry.project.name}
                              </span>
                            )}
                          </div>
                          {entry.description && (
                            <p className="text-muted-foreground truncate mt-0.5">
                              {entry.description}
                            </p>
                          )}
                        </div>
                        <span className="font-medium shrink-0">
                          {formatHours(entry.durationMinutes)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Outstanding Invoices */}
          {invoices.length > 0 && (
            <Card className="squircle">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileText className="size-5" />
                  Outstanding Invoices
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {invoices.map((invoice) => (
                    <Link
                      key={invoice.id}
                      href={`/invoices/${invoice.id}`}
                      className="squircle flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                    >
                      <div>
                        <span className="font-medium">{invoice.invoiceNumber}</span>
                        <span className="text-sm text-muted-foreground ml-2">
                          {format(new Date(invoice.periodStart), "MMM d")} -{" "}
                          {format(new Date(invoice.periodEnd), "MMM d, yyyy")}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span
                          className={`text-xs px-2 py-1 rounded ${
                            invoice.status === "sent"
                              ? "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {invoice.status || "draft"}
                        </span>
                        <span className="font-medium">
                          {formatCurrency(invoice.subtotal)}
                        </span>
                      </div>
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Dialogs */}
      <ClientDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        client={toClientType(client)}
        orgId={orgId}
        allClients={allClients.map(toClientType)}
        onSuccess={handleClientUpdated}
      />

      <ProjectDialog
        open={projectDialogOpen}
        onOpenChange={setProjectDialogOpen}
        project={null}
        orgId={orgId}
        clients={[{ id: client.id, name: client.name, color: client.color }]}
        defaultClientId={client.id}
        onSuccess={fetchData}
      />
    </div>
  );
}

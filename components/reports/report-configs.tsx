"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ViewSwitcher } from "@/components/view-switcher";
import { useViewPreference } from "@/hooks/use-view-preference";
import {
  Plus,
  Loader2,
  ExternalLink,
  Copy,
  Trash2,
  Settings,
  Check,
  X,
} from "lucide-react";
import { PageToolbar } from "@/components/page-toolbar";

type Client = {
  id: string;
  name: string;
  color: string | null;
};

type Project = {
  id: string;
  name: string;
  clientId: string;
};

type ReportConfig = {
  id: string;
  slug: string;
  enabled: boolean;
  showRates: boolean;
  autoSend: boolean;
  autoSendDay: number | null;
  autoSendHour: number | null;
  recipients: string[];
  clientId: string | null;
  projectId: string | null;
  client: { id: string; name: string; color: string | null } | null;
  project: { id: string; name: string } | null;
  createdAt: string;
};

type ReportConfigsProps = {
  orgId: string;
};

const DAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const HOURS = Array.from({ length: 24 }, (_, i) => ({
  value: i,
  label: `${i.toString().padStart(2, "0")}:00`,
}));

const REPORT_VIEWS = ["list", "table"] as const;

export function ReportConfigs({ orgId }: ReportConfigsProps) {
  const [view, setView] = useViewPreference("client-reports", REPORT_VIEWS, "list");
  const [configs, setConfigs] = useState<ReportConfig[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Toolbar filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "disabled">("all");

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedConfig, setSelectedConfig] = useState<ReportConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Form state for create
  const [newConfigType, setNewConfigType] = useState<"client" | "project">("client");
  const [newConfigClientId, setNewConfigClientId] = useState<string>("");
  const [newConfigProjectId, setNewConfigProjectId] = useState<string>("");

  // Form state for edit
  const [editEnabled, setEditEnabled] = useState(true);
  const [editShowRates, setEditShowRates] = useState(false);
  const [editAutoSend, setEditAutoSend] = useState(false);
  const [editAutoSendDay, setEditAutoSendDay] = useState<number>(1);
  const [editAutoSendHour, setEditAutoSendHour] = useState<number>(9);
  const [editRecipients, setEditRecipients] = useState("");

  const fetchConfigs = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/reports`);
      if (response.ok) {
        const data = await response.json();
        setConfigs(data);
      }
    } catch (err) {
      console.error("Error fetching report configs:", err);
    }
  }, [orgId]);

  const fetchClients = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/clients`);
      if (response.ok) {
        const data = await response.json();
        setClients(data);
      }
    } catch (err) {
      console.error("Error fetching clients:", err);
    }
  }, [orgId]);

  const fetchProjects = useCallback(async () => {
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/projects`);
      if (response.ok) {
        const data = await response.json();
        setProjects(data);
      }
    } catch (err) {
      console.error("Error fetching projects:", err);
    }
  }, [orgId]);

  useEffect(() => {
    Promise.all([fetchConfigs(), fetchClients(), fetchProjects()]).finally(() => {
      setIsLoading(false);
    });
  }, [fetchConfigs, fetchClients, fetchProjects]);

  const handleCreate = async () => {
    const clientId = newConfigType === "client" ? newConfigClientId : null;
    const projectId = newConfigType === "project" ? newConfigProjectId : null;

    if (!clientId && !projectId) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/reports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, projectId }),
      });

      if (response.ok) {
        setCreateDialogOpen(false);
        setNewConfigClientId("");
        setNewConfigProjectId("");
        fetchConfigs();
      }
    } catch (err) {
      console.error("Error creating config:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenEdit = (config: ReportConfig) => {
    setSelectedConfig(config);
    setEditEnabled(config.enabled);
    setEditShowRates(config.showRates);
    setEditAutoSend(config.autoSend);
    setEditAutoSendDay(config.autoSendDay ?? 1);
    setEditAutoSendHour(config.autoSendHour ?? 9);
    setEditRecipients((config.recipients || []).join(", "));
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!selectedConfig) return;

    setIsSaving(true);
    try {
      const recipients = editRecipients
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0);

      const response = await fetch(
        `/api/v1/organizations/${orgId}/reports/${selectedConfig.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: editEnabled,
            showRates: editShowRates,
            autoSend: editAutoSend,
            autoSendDay: editAutoSend ? editAutoSendDay : null,
            autoSendHour: editAutoSend ? editAutoSendHour : null,
            recipients,
          }),
        }
      );

      if (response.ok) {
        setEditDialogOpen(false);
        fetchConfigs();
      }
    } catch (err) {
      console.error("Error updating config:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedConfig) return;

    setIsSaving(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/reports/${selectedConfig.id}`,
        { method: "DELETE" }
      );

      if (response.ok) {
        setDeleteDialogOpen(false);
        setSelectedConfig(null);
        fetchConfigs();
      }
    } catch (err) {
      console.error("Error deleting config:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const copyReportUrl = (slug: string) => {
    const url = `${window.location.origin}/r/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const getReportName = (config: ReportConfig) => {
    if (config.project) {
      return `${config.client?.name} / ${config.project.name}`;
    }
    return config.client?.name || "Unknown";
  };

  // Filter out clients/projects that already have configs
  const availableClients = clients.filter(
    (c) => !configs.some((cfg) => cfg.clientId === c.id && !cfg.projectId)
  );
  const availableProjects = projects.filter(
    (p) => !configs.some((cfg) => cfg.projectId === p.id)
  );

  const filtersActive = searchQuery !== "" || statusFilter !== "all";

  const filteredConfigs = configs.filter((config) => {
    if (searchQuery) {
      const name = getReportName(config).toLowerCase();
      if (!name.includes(searchQuery.toLowerCase())) return false;
    }
    if (statusFilter === "active" && !config.enabled) return false;
    if (statusFilter === "disabled" && config.enabled) return false;
    return true;
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <PageToolbar
          actions={
            <>
              <ViewSwitcher views={REPORT_VIEWS} value={view} onValueChange={setView} />
              <Button onClick={() => setCreateDialogOpen(true)} className="squircle">
                <Plus className="size-4" />
                New Report
              </Button>
            </>
          }
        >
          <Input
            placeholder="Search reports..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="squircle w-[200px]"
          />
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as "all" | "active" | "disabled")}
          >
            <SelectTrigger className="squircle w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="squircle">
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
          {filtersActive && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
              }}
              className="squircle"
            >
              <X className="size-4" />
              Clear
            </Button>
          )}
        </PageToolbar>

        {configs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-muted-foreground">No shared reports yet.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create a report to share time tracking summaries with clients.
            </p>
          </div>
        ) : filteredConfigs.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center">
            <p className="text-muted-foreground">No matching reports.</p>
            <p className="text-sm text-muted-foreground mt-1">
              Try adjusting your search or filters.
            </p>
          </div>
        ) : view === "table" ? (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Report</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Auto-Send</TableHead>
                  <TableHead>Recipients</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredConfigs.map((config) => (
                  <TableRow key={config.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {config.client?.color && (
                          <div
                            className="size-3 rounded-full shrink-0"
                            style={{ backgroundColor: config.client.color }}
                          />
                        )}
                        <span className="font-medium">{getReportName(config)}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          config.enabled
                            ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                            : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {config.enabled ? "Active" : "Disabled"}
                      </span>
                    </TableCell>
                    <TableCell>
                      {config.autoSend ? (
                        <span className="text-sm">
                          {DAYS.find((d) => d.value === config.autoSendDay)?.label} at{" "}
                          {config.autoSendHour?.toString().padStart(2, "0")}:00
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">Off</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {config.recipients && config.recipients.length > 0 ? (
                        <span className="text-sm">
                          {config.recipients.length === 1
                            ? config.recipients[0]
                            : `${config.recipients.length} recipients`}
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => copyReportUrl(config.slug)}
                          className="squircle"
                        >
                          {copiedSlug === config.slug ? (
                            <Check className="size-4 text-green-600" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => window.open(`/r/${config.slug}`, "_blank")}
                          className="squircle"
                        >
                          <ExternalLink className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleOpenEdit(config)}
                          className="squircle"
                        >
                          <Settings className="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setSelectedConfig(config);
                            setDeleteDialogOpen(true);
                          }}
                          className="squircle text-destructive hover:text-destructive"
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="rounded-lg border divide-y">
            {filteredConfigs.map((config) => (
              <div
                key={config.id}
                className="p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {config.client?.color && (
                    <div
                      className="size-3 rounded-full shrink-0"
                      style={{ backgroundColor: config.client.color }}
                    />
                  )}
                  <div className="min-w-0">
                    <div className="font-medium truncate">{getReportName(config)}</div>
                    <div className="text-sm text-muted-foreground flex items-center gap-2">
                      <span className={config.enabled ? "text-green-600" : "text-muted-foreground"}>
                        {config.enabled ? "Active" : "Disabled"}
                      </span>
                      {config.autoSend && (
                        <>
                          <span>•</span>
                          <span>
                            Auto-sends {DAYS.find((d) => d.value === config.autoSendDay)?.label} at{" "}
                            {config.autoSendHour?.toString().padStart(2, "0")}:00
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => copyReportUrl(config.slug)}
                    className="squircle"
                  >
                    {copiedSlug === config.slug ? (
                      <Check className="size-4 text-green-600" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => window.open(`/r/${config.slug}`, "_blank")}
                    className="squircle"
                  >
                    <ExternalLink className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleOpenEdit(config)}
                    className="squircle"
                  >
                    <Settings className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setSelectedConfig(config);
                      setDeleteDialogOpen(true);
                    }}
                    className="squircle text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Shared Report</DialogTitle>
            <DialogDescription>
              Create a shareable report link for a client or project.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Report Type</Label>
              <Select
                value={newConfigType}
                onValueChange={(v) => setNewConfigType(v as "client" | "project")}
              >
                <SelectTrigger className="squircle">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="squircle">
                  <SelectItem value="client">Client Report</SelectItem>
                  <SelectItem value="project">Project Report</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newConfigType === "client" ? (
              <div className="grid gap-2">
                <Label>Client</Label>
                <Select value={newConfigClientId} onValueChange={setNewConfigClientId}>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select a client" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    {availableClients.map((client) => (
                      <SelectItem key={client.id} value={client.id}>
                        <div className="flex items-center gap-2">
                          {client.color && (
                            <div
                              className="size-2.5 rounded-full"
                              style={{ backgroundColor: client.color }}
                            />
                          )}
                          {client.name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label>Project</Label>
                <Select value={newConfigProjectId} onValueChange={setNewConfigProjectId}>
                  <SelectTrigger className="squircle">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent className="squircle">
                    {availableProjects.map((project) => {
                      const client = clients.find((c) => c.id === project.clientId);
                      return (
                        <SelectItem key={project.id} value={project.id}>
                          <div className="flex items-center gap-2">
                            {client?.color && (
                              <div
                                className="size-2.5 rounded-full"
                                style={{ backgroundColor: client.color }}
                              />
                            )}
                            {client?.name} / {project.name}
                          </div>
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={isSaving}
              className="squircle"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                isSaving ||
                (newConfigType === "client" ? !newConfigClientId : !newConfigProjectId)
              }
              className="squircle"
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Create Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Report Settings</DialogTitle>
            <DialogDescription>
              Configure settings for {selectedConfig && getReportName(selectedConfig)}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Enabled</Label>
                <p className="text-sm text-muted-foreground">
                  Allow access to this report
                </p>
              </div>
              <Switch checked={editEnabled} onCheckedChange={setEditEnabled} />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Show Rates</Label>
                <p className="text-sm text-muted-foreground">
                  Display hourly rates and amounts
                </p>
              </div>
              <Switch checked={editShowRates} onCheckedChange={setEditShowRates} />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label>Auto-Send Weekly</Label>
                <p className="text-sm text-muted-foreground">
                  Email report to recipients automatically
                </p>
              </div>
              <Switch checked={editAutoSend} onCheckedChange={setEditAutoSend} />
            </div>

            {editAutoSend && (
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Day</Label>
                    <Select
                      value={editAutoSendDay.toString()}
                      onValueChange={(v) => setEditAutoSendDay(parseInt(v))}
                    >
                      <SelectTrigger className="squircle">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="squircle">
                        {DAYS.map((day) => (
                          <SelectItem key={day.value} value={day.value.toString()}>
                            {day.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>Time</Label>
                    <Select
                      value={editAutoSendHour.toString()}
                      onValueChange={(v) => setEditAutoSendHour(parseInt(v))}
                    >
                      <SelectTrigger className="squircle">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="squircle max-h-60">
                        {HOURS.map((hour) => (
                          <SelectItem key={hour.value} value={hour.value.toString()}>
                            {hour.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label>Recipients</Label>
                  <Input
                    value={editRecipients}
                    onChange={(e) => setEditRecipients(e.target.value)}
                    placeholder="email@example.com, another@example.com"
                    className="squircle"
                  />
                  <p className="text-xs text-muted-foreground">
                    Comma-separated email addresses
                  </p>
                </div>
              </>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              disabled={isSaving}
              className="squircle"
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={isSaving} className="squircle">
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent className="squircle">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Report?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the shared report for{" "}
              {selectedConfig && getReportName(selectedConfig)}. The report URL will no
              longer work.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="squircle" disabled={isSaving}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isSaving}
              className="squircle bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving && <Loader2 className="size-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

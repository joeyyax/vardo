"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Plus,
  Play,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Power,
  PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";

type CronJob = {
  id: string;
  name: string;
  type: "command" | "url";
  schedule: string;
  command: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: "success" | "failed" | "running" | null;
  lastLog: string | null;
  createdAt: string;
};

type Props = {
  projectId: string;
  orgId: string;
};

const SCHEDULE_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 3 AM", value: "0 3 * * *" },
  { label: "Weekly (Sunday midnight)", value: "0 0 * * 0" },
  { label: "Custom", value: "custom" },
] as const;

function scheduleLabel(cron: string): string {
  const preset = SCHEDULE_PRESETS.find((p) => p.value === cron);
  return preset ? preset.label : cron;
}

function StatusIcon({ status }: { status: CronJob["lastStatus"] }) {
  switch (status) {
    case "success":
      return <CheckCircle2 className="size-4 text-status-success" />;
    case "failed":
      return <XCircle className="size-4 text-status-error" />;
    case "running":
      return <Loader2 className="size-4 text-status-info animate-spin" />;
    default:
      return <Clock className="size-4 text-muted-foreground" />;
  }
}

export function CronManager({ projectId, orgId }: Props) {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [expandedLog, setExpandedLog] = useState<string | null>(null);

  // Form state
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [jobType, setJobType] = useState<"command" | "url">("command");
  const [schedulePreset, setSchedulePreset] = useState("0 * * * *");
  const [customSchedule, setCustomSchedule] = useState("");
  const [command, setCommand] = useState("");

  const baseUrl = `/api/v1/organizations/${orgId}/projects/${projectId}/cron`;

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.cronJobs || []);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  function openCreate() {
    setEditId(null);
    setName("");
    setJobType("command");
    setSchedulePreset("0 * * * *");
    setCustomSchedule("");
    setCommand("");
    setSheetOpen(true);
  }

  function openEdit(job: CronJob) {
    setEditId(job.id);
    setName(job.name);
    setJobType(job.type);
    setCommand(job.command);
    const preset = SCHEDULE_PRESETS.find((p) => p.value === job.schedule);
    if (preset && preset.value !== "custom") {
      setSchedulePreset(job.schedule);
      setCustomSchedule("");
    } else {
      setSchedulePreset("custom");
      setCustomSchedule(job.schedule);
    }
    setSheetOpen(true);
  }

  async function handleSave() {
    if (!name.trim() || !command.trim()) return;
    const schedule =
      schedulePreset === "custom" ? customSchedule.trim() : schedulePreset;
    if (!schedule) return;

    setSaving(true);
    try {
      const body = editId
        ? { id: editId, name: name.trim(), type: jobType, schedule, command: command.trim() }
        : { name: name.trim(), type: jobType, schedule, command: command.trim() };

      const res = await fetch(baseUrl, {
        method: editId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        toast.success(editId ? "Cron job updated" : "Cron job created");
        setSheetOpen(false);
        fetchJobs();
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      const res = await fetch(baseUrl, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: deleteId }),
      });
      if (res.ok) {
        toast.success("Cron job deleted");
        setDeleteId(null);
        fetchJobs();
      } else {
        toast.error("Failed to delete");
      }
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  async function toggleEnabled(id: string, enabled: boolean) {
    try {
      const res = await fetch(baseUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      if (res.ok) {
        toast.success(enabled ? "Cron job enabled" : "Cron job paused");
        fetchJobs();
      }
    } catch {
      toast.error("Failed to update");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Scheduled tasks that run commands inside your containers.
            </p>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="mr-1.5 size-4" />
            Add Cron Job
          </Button>
        </div>

        {jobs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
            <Clock className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No scheduled tasks. Add a cron job to run commands on a schedule.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="squircle rounded-lg border bg-card p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <StatusIcon status={job.lastStatus} />
                      <p className="text-sm font-medium">{job.name}</p>
                      {job.enabled ? (
                        <Badge
                          variant="outline"
                          className="text-xs border-transparent bg-status-success-muted text-status-success"
                        >
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">
                          Paused
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        {scheduleLabel(job.schedule)}
                      </span>
                      {job.lastRunAt && (
                        <span>
                          Last run:{" "}
                          {new Date(job.lastRunAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-muted-foreground truncate">
                      <Badge variant="outline" className="text-[10px] mr-1.5 font-sans">
                        {job.type === "url" ? "URL" : "CMD"}
                      </Badge>
                      {job.command}
                    </p>
                    {job.lastLog && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedLog(
                            expandedLog === job.id ? null : job.id
                          )
                        }
                        className="text-xs text-muted-foreground hover:text-foreground"
                      >
                        {expandedLog === job.id ? "Hide output" : "Show output"}
                      </button>
                    )}
                    {expandedLog === job.id && job.lastLog && (
                      <pre className="mt-2 rounded-md bg-zinc-950 p-3 text-xs text-zinc-300 overflow-x-auto max-h-48 overflow-y-auto">
                        {job.lastLog}
                      </pre>
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => openEdit(job)}
                    >
                      Edit
                    </Button>
                    <Switch
                      checked={job.enabled}
                      onCheckedChange={(checked) =>
                        toggleEnabled(job.id, checked)
                      }
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setDeleteId(job.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create/Edit Sheet */}
      <BottomSheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>
              {editId ? "Edit cron job" : "Add cron job"}
            </BottomSheetTitle>
            <BottomSheetDescription>
              Run a command inside your container on a schedule.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="cron-name">Name</Label>
                <Input
                  id="cron-name"
                  placeholder="Database cleanup"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label>Schedule</Label>
                <Select
                  value={schedulePreset}
                  onValueChange={setSchedulePreset}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SCHEDULE_PRESETS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {schedulePreset === "custom" && (
                  <Input
                    placeholder="*/5 * * * *"
                    className="font-mono"
                    value={customSchedule}
                    onChange={(e) => setCustomSchedule(e.target.value)}
                  />
                )}
              </div>

              <div className="grid gap-2">
                <Label>Type</Label>
                <Select value={jobType} onValueChange={(v) => setJobType(v as "command" | "url")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="command">Command (docker exec)</SelectItem>
                    <SelectItem value="url">URL (HTTP request)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="cron-command">
                  {jobType === "url" ? "URL" : "Command"}
                </Label>
                <Input
                  id="cron-command"
                  placeholder={jobType === "url" ? "https://myapp.example.com/api/cron" : "wp cron event run --due-now"}
                  className="font-mono"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  {jobType === "url"
                    ? "Sends a GET request to this URL. Supports internal Docker hostnames and public URLs."
                    : "Runs via docker exec inside your container."}
                </p>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setSheetOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={
                saving ||
                !name.trim() ||
                !command.trim() ||
                (schedulePreset === "custom" && !customSchedule.trim())
              }
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : editId ? (
                "Update"
              ) : (
                "Create"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      <ConfirmDeleteDialog
        open={!!deleteId}
        onOpenChange={(open) => !open && setDeleteId(null)}
        onConfirm={handleDelete}
        loading={deleting}
        title="Delete cron job"
        description="This will permanently remove this scheduled task."
      />
    </>
  );
}

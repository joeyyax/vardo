"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Loader2,
  Plus,
  EyeOff,
  X,
  Rocket,
  RotateCcw,
  Square,
  Terminal,
  FileText,
  Variable,
  ChevronDown,
  Check,
  Globe2,
  Star,
} from "lucide-react";
import { toast } from "sonner";
import { PageToolbar } from "@/components/page-toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DetailField } from "@/components/ui/detail-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { LogViewer, highlightLogLine } from "@/components/log-viewer";
import { EnvEditor } from "@/components/env-editor";
import { VolumesPanel } from "@/components/volumes-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  trigger: "manual" | "webhook" | "api" | "rollback";
  gitSha: string | null;
  gitMessage: string | null;
  durationMs: number | null;
  log: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  triggeredByUser: {
    id: string;
    name: string | null;
    image: string | null;
  } | null;
};

type Domain = {
  id: string;
  domain: string;
  serviceName: string | null;
  port: number | null;
  isPrimary: boolean | null;
};

type EnvVar = {
  id: string;
  key: string;
  isSecret: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

type Environment = {
  id: string;
  name: string;
  type: "production" | "staging" | "preview";
  domain: string | null;
  isDefault: boolean | null;
  createdAt: Date;
};

type Project = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct";
  deployType: "compose" | "dockerfile" | "image" | "static";
  gitUrl: string | null;
  gitBranch: string | null;
  imageName: string | null;
  composeFilePath: string | null;
  rootDirectory: string | null;
  containerPort: number | null;
  autoTraefikLabels: boolean | null;
  autoDeploy: boolean | null;
  status: "active" | "stopped" | "error" | "deploying";
  createdAt: Date;
  updatedAt: Date;
  deployments: Deployment[];
  domains: Domain[];
  envVars: EnvVar[];
  environments: Environment[];
  projectTags?: { tag: Tag }[];
};

type Tag = {
  id: string;
  name: string;
  color: string;
};

type ProjectDetailProps = {
  project: Project;
  orgId: string;
  userRole: string;
  allTags?: Tag[];
  allProjectNames?: string[];
  orgVarKeys?: string[];
};

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success">
          Active
        </Badge>
      );
    case "deploying":
      return (
        <Badge className="border-transparent bg-status-info-muted text-status-info animate-pulse">
          Deploying
        </Badge>
      );
    case "error":
      return (
        <Badge className="border-transparent bg-status-error-muted text-status-error">
          Error
        </Badge>
      );
    default:
      return (
        <Badge className="border-transparent bg-status-neutral-muted text-status-neutral">
          Stopped
        </Badge>
      );
  }
}

function DeploymentStatusBadge({ status }: { status: Deployment["status"] }) {
  switch (status) {
    case "success":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success">
          Success
        </Badge>
      );
    case "running":
      return (
        <Badge className="border-transparent bg-status-info-muted text-status-info animate-pulse">
          Running
        </Badge>
      );
    case "failed":
      return (
        <Badge className="border-transparent bg-status-error-muted text-status-error">
          Failed
        </Badge>
      );
    case "cancelled":
      return <Badge variant="secondary">Cancelled</Badge>;
    default:
      return <Badge variant="secondary">Queued</Badge>;
  }
}

function deployTypeLabel(deployType: string) {
  switch (deployType) {
    case "compose":
      return "Compose";
    case "dockerfile":
      return "Dockerfile";
    case "image":
      return "Image";
    case "static":
      return "Static";
    default:
      return deployType;
  }
}

function formatUptime(date: Date): string {
  const ms = Date.now() - new Date(date).getTime();
  const s = Math.floor(ms / 1000) % 60;
  const m = Math.floor(ms / 60000) % 60;
  const h = Math.floor(ms / 3600000) % 24;
  const d = Math.floor(ms / 86400000);
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function Timer({ since, className }: { since: number; className?: string }) {
  const [elapsed, setElapsed] = useState<string | null>(null);
  useEffect(() => {
    const tick = () => {
      const ms = Date.now() - since;
      const s = Math.floor(ms / 1000);
      if (s < 60) setElapsed(`${s}s`);
      else setElapsed(`${Math.floor(s / 60)}m ${s % 60}s`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!elapsed) return null;
  return <span className={`tabular-nums ${className || ""}`}>{elapsed}</span>;
}

function Uptime({ since }: { since: Date }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(formatUptime(since));
    const interval = setInterval(() => setText(formatUptime(since)), 1000);
    return () => clearInterval(interval);
  }, [since]);
  if (!text) return null;
  return (
    <span className="ml-1.5 text-status-success/70 text-xs font-normal tabular-nums">
      {text}
    </span>
  );
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function ProjectDetail({ project, orgId, userRole, allTags = [], allProjectNames = [], orgVarKeys = [] }: ProjectDetailProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Edit form state
  const [displayName, setDisplayName] = useState(project.displayName);
  const [description, setDescription] = useState(project.description || "");
  const [containerPort, setContainerPort] = useState(
    project.containerPort?.toString() || ""
  );
  const [autoPort, setAutoPort] = useState(!project.containerPort);
  const [autoTraefikLabels, setAutoTraefikLabels] = useState(
    project.autoTraefikLabels ?? false
  );
  const [autoDeploy, setAutoDeploy] = useState(project.autoDeploy ?? false);
  const [gitBranch, setGitBranch] = useState(project.gitBranch || "");
  const [rootDirectory, setRootDirectory] = useState(project.rootDirectory || "");


  // Domain state
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainSaving, setDomainSaving] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [deletingDomainId, setDeletingDomainId] = useState<string | null>(null);

  const [deploying, setDeploying] = useState(false);
  const [viewingLogId, setViewingLogId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const [activeTab, setActiveTabState] = useState(
    searchParams.get("tab") || "deployments"
  );

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState({}, "", url.toString());
  }, []);

  // Tag management state
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);

  const projectTagIds = new Set(
    (project.projectTags ?? []).map((pt) => pt.tag.id)
  );

  async function handleToggleTag(tagId: string) {
    const isApplied = projectTagIds.has(tagId);
    setTogglingTagId(tagId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/tags`,
        {
          method: isApplied ? "DELETE" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tagId }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update tag");
        return;
      }
      toast.success(isApplied ? "Tag removed" : "Tag added");
      router.refresh();
    } catch {
      toast.error("Failed to update tag");
    } finally {
      setTogglingTagId(null);
    }
  }

  const canDelete = userRole === "owner" || userRole === "admin";

  async function handleSave() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        displayName: displayName.trim(),
        description: description.trim() || null,
        autoTraefikLabels,
        autoDeploy,
      };
      if (containerPort) {
        body.containerPort = parseInt(containerPort, 10);
      } else {
        body.containerPort = null;
      }
      if (project.source === "git") {
        body.gitBranch = gitBranch;
      }
      if (rootDirectory.trim()) {
        body.rootDirectory = rootDirectory.trim();
      } else {
        body.rootDirectory = null;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
        return;
      }

      toast.success("Project updated");
      setEditOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete");
        return;
      }

      toast.success("Project deleted");
      router.push("/projects");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployStartTime, setDeployStartTime] = useState<number | null>(null);
  const [deployStages, setDeployStages] = useState<
    Record<string, "running" | "success" | "failed" | "skipped">
  >({});
  const [expandedDeployLog, setExpandedDeployLog] = useState(false);
  const [deployAbort, setDeployAbort] = useState<AbortController | null>(null);

  async function handleDeploy() {
    setDeploying(true);
    setActiveTab("deployments");
    setDeployLog([]);
    setDeployStages({});
    setExpandedDeployLog(false);
    setDeployStartTime(Date.now());

    // Queue stage updates with minimum display time
    const stageQueue: { stage: string; status: string }[] = [];
    let processingStages = false;
    const MIN_STAGE_MS = 600;

    async function processStageQueue() {
      if (processingStages) return;
      processingStages = true;
      while (stageQueue.length > 0) {
        const { stage, status } = stageQueue.shift()!;
        setDeployStages((prev) => ({ ...prev, [stage]: status as "running" | "success" | "failed" | "skipped" }));
        if (status === "running") {
          await new Promise((r) => setTimeout(r, MIN_STAGE_MS));
        }
      }
      processingStages = false;
    }

    const abort = new AbortController();
    setDeployAbort(abort);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/deploy`,
        { method: "POST", signal: abort.signal }
      );

      if (!res.body) {
        toast.error("Deployment failed — no response");
        setDeploying(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "log") {
              setDeployLog((prev) => [...prev, data as string]);
            } else if (eventType === "stage") {
              const { stage, status } = data as { stage: string; status: string };
              stageQueue.push({ stage, status });
              processStageQueue();
            } else if (eventType === "done") {
              const result = data as { deploymentId: string; success: boolean; durationMs: number };
              if (result.success) {
                toast.success(`Deployed in ${result.durationMs}ms`);
              } else {
                toast.error("Deployment failed");
              }
              if (result.deploymentId) {
                setViewingLogId(result.deploymentId);
              }
            } else if (eventType === "error") {
              toast.error((data as { message: string }).message);
            }
          }
        }
      }

      router.refresh();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        toast.info("Deployment aborted");
      } else {
        toast.error("Deployment failed");
      }
    } finally {
      setDeploying(false);
      setDeployAbort(null);
    }
  }

  async function handleSetPrimaryDomain(domainId: string) {
    try {
      // Clear all primary flags, then set the selected one
      for (const d of project.domains) {
        if (d.id === domainId && !d.isPrimary) {
          // This is a simple approach — ideally a single API call
          await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/domains/primary`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domainId }),
          });
          toast.success("Primary domain updated");
          router.refresh();
          return;
        }
      }
    } catch {
      toast.error("Failed to update primary domain");
    }
  }

  async function handleDomainAdd() {
    if (!newDomain.trim()) return;
    setDomainSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/domains`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            domain: newDomain.trim(),
            port: newDomainPort ? parseInt(newDomainPort, 10) : undefined,
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to add domain");
        return;
      }
      toast.success("Domain added");
      setDomainOpen(false);
      setNewDomain("");
      setNewDomainPort("");
      router.refresh();
    } catch {
      toast.error("Failed to add domain");
    } finally {
      setDomainSaving(false);
    }
  }

  async function handleDomainDelete(id: string) {
    setDeletingDomainId(id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/domains`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete domain");
        return;
      }
      toast.success("Domain removed");
      router.refresh();
    } catch {
      toast.error("Failed to delete domain");
    } finally {
      setDeletingDomainId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {project.status === "active" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="bg-status-success-muted text-status-success hover:bg-status-success/20">
                    <span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />
                    Running
                    {(() => {
                      const lastDeploy = project.deployments.find((d) => d.status === "success");
                      return lastDeploy ? (
                        <Uptime since={lastDeploy.finishedAt || lastDeploy.startedAt} />
                      ) : null;
                    })()}
                    <ChevronDown className="ml-1.5 size-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={deploying} onClick={handleDeploy}>
                    <Rocket className="mr-2 size-4" />
                    Redeploy
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={async () => {
                      const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/restart`, { method: "POST" });
                      const data = await res.json();
                      data.success ? toast.success("Restarted") : toast.error("Restart failed");
                      router.refresh();
                    }}
                  >
                    <RotateCcw className="mr-2 size-4" />
                    Restart
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={async () => {
                      const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/stop`, { method: "POST" });
                      const data = await res.json();
                      data.success ? toast.success("Stopped") : toast.error("Stop failed");
                      router.refresh();
                    }}
                  >
                    <Square className="mr-2 size-4" />
                    Stop
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button size="sm" disabled={deploying} onClick={handleDeploy}>
                {deploying ? (
                  <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
                ) : (
                  <><Rocket className="mr-1.5 size-4" />{project.status === "error" ? "Retry" : "Deploy"}</>
                )}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1.5 size-4" />
              Edit
            </Button>
            {canDelete && (
              <Button
                size="sm"
                variant="outline"
                className="text-destructive hover:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="mr-1.5 size-4" />
                Delete
              </Button>
            )}
          </div>
        }
      >
        <Button variant="ghost" size="sm" asChild>
          <Link href="/projects">
            <ArrowLeft className="mr-1.5 size-4" />
            Projects
          </Link>
        </Button>
        <h1 className="text-xl font-semibold tracking-tight">
          {project.displayName}
        </h1>
        <StatusBadge status={project.status} />
      </PageToolbar>

      {/* Overview — always visible */}
      <div className="space-y-4">
        {project.description && (
          <p className="text-sm text-muted-foreground">
            {project.description}
          </p>
        )}

        {/* Tags */}
        <div className="flex items-center gap-2 flex-wrap">
          {(project.projectTags ?? []).map(({ tag }) => (
            <span
              key={tag.id}
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
              style={{
                backgroundColor: `${tag.color}20`,
                color: tag.color,
              }}
            >
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: tag.color }}
                aria-hidden="true"
              />
              {tag.name}
            </span>
          ))}

          {allTags.length > 0 && (
            <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
              <PopoverTrigger asChild>
                <button
                  className="inline-flex items-center justify-center size-6 rounded-full border border-dashed text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
                  aria-label="Manage tags"
                >
                  <Plus className="size-3" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-2">
                <div className="space-y-1">
                  {allTags.map((tag) => {
                    const isApplied = projectTagIds.has(tag.id);
                    const isToggling = togglingTagId === tag.id;
                    return (
                      <button
                        key={tag.id}
                        disabled={isToggling}
                        onClick={() => handleToggleTag(tag.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent transition-colors disabled:opacity-50"
                      >
                        <span
                          className="size-3 rounded-full shrink-0"
                          style={{ backgroundColor: tag.color }}
                          aria-hidden="true"
                        />
                        <span className="flex-1 text-left truncate">{tag.name}</span>
                        {isToggling ? (
                          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                        ) : isApplied ? (
                          <Check className="size-3.5 text-foreground" />
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>

        {/* Domains summary */}
        {project.domains.length > 0 && (
          <div className="flex items-center gap-2 text-sm">
            <Globe2 className="size-4 text-muted-foreground shrink-0" />
            {(() => {
              const primary = project.domains.find((d) => d.isPrimary) || project.domains[0];
              const rest = project.domains.length - 1;
              return (
                <>
                  <a
                    href={`https://${primary.domain}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-muted-foreground hover:text-foreground transition-colors underline-offset-4 hover:underline"
                  >
                    {primary.domain}
                  </a>
                  {rest > 0 && (
                    <button
                      type="button"
                      onClick={() => setActiveTab("domains")}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      and {rest} more
                    </button>
                  )}
                </>
              );
            })()}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DetailField label="Source">
            {project.source === "git" ? "Git Repository" : "Direct"}
          </DetailField>

          <DetailField label="Deploy Type">
            {deployTypeLabel(project.deployType)}
          </DetailField>

          {project.source === "git" && (
            <>
              <DetailField label="Git URL">
                {project.gitUrl || "-"}
              </DetailField>
              <DetailField label="Branch">
                {project.gitBranch || "main"}
              </DetailField>
            </>
          )}

          {project.deployType === "image" && (
            <DetailField label="Image">
              {project.imageName || "-"}
            </DetailField>
          )}

          {project.deployType === "compose" && (
            <DetailField label="Compose Path">
              {project.composeFilePath || "docker-compose.yml"}
            </DetailField>
          )}

          {project.rootDirectory && (
            <DetailField label="Root Directory">
              {project.rootDirectory}
            </DetailField>
          )}

          <DetailField label="Container Port">
            {project.containerPort || "-"}
          </DetailField>

          <DetailField label="Auto Traefik Labels">
            {project.autoTraefikLabels ? "Enabled" : "Disabled"}
          </DetailField>

          <DetailField label="Auto Deploy">
            {project.autoDeploy ? "Enabled" : "Disabled"}
          </DetailField>

          <DetailField label="Created">
            {new Date(project.createdAt).toLocaleDateString()}
          </DetailField>

          <DetailField label="Updated">
            {new Date(project.updatedAt).toLocaleDateString()}
          </DetailField>
        </div>
      </div>

      {/* Tabbed sections */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="deployments">
            Deployments
            {project.deployments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {project.deployments.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="variables">
            Variables
            {project.envVars.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {project.envVars.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="domains">
            Domains
            {project.domains.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {project.domains.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="logs">
            Logs
          </TabsTrigger>
          <TabsTrigger value="volumes">
            Volumes
          </TabsTrigger>
          <TabsTrigger value="terminal">
            Terminal
          </TabsTrigger>
          <TabsTrigger value="metrics">
            Metrics
          </TabsTrigger>
          <TabsTrigger value="environments">
            Environments
            {project.environments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {project.environments.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="deployments" className="pt-4 space-y-4">
          {project.deployments.length === 0 && !deploying ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No deployments yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* In-progress deployment */}
              {deploying && (
                <div className="squircle rounded-lg border bg-status-info-muted overflow-hidden">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setExpandedDeployLog(!expandedDeployLog)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setExpandedDeployLog(!expandedDeployLog); }}
                    className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge variant="outline" className="animate-pulse shrink-0">
                        <Loader2 className="mr-1 size-3 animate-spin" />
                        Deploying
                      </Badge>
                      {/* Stage indicators inline */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {(["clone", "build", "deploy", "healthcheck", "routing", "cleanup"] as const).map((s, i) => {
                          const status = deployStages[s];
                          if (!status) return null;
                          const labels: Record<string, string> = {
                            clone: "Clone", build: "Build", deploy: "Deploy",
                            healthcheck: "Health", routing: "Route", cleanup: "Cleanup",
                          };
                          return (
                            <div key={s} className="flex items-center gap-1">
                              {i > 0 && status && <span className="text-muted-foreground/30 text-xs">›</span>}
                              {status === "running" && <Loader2 className="size-3 animate-spin text-status-info" />}
                              {status === "success" && <Check className="size-3 text-status-success" />}
                              {status === "failed" && <X className="size-3 text-status-error" />}
                              {status === "skipped" && <span className="text-muted-foreground text-xs">-</span>}
                              <span className={`text-xs ${
                                status === "running" ? "text-status-info" :
                                status === "success" ? "text-status-success" :
                                status === "failed" ? "text-status-error" :
                                "text-muted-foreground"
                              }`}>
                                {labels[s]}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {deployStartTime && (
                        <Timer since={deployStartTime} className="text-xs text-muted-foreground" />
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); deployAbort?.abort(); }}
                      >
                        <Square className="mr-1 size-3" />
                        Abort
                      </Button>
                      <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expandedDeployLog ? "rotate-180" : ""}`} />
                    </div>
                  </div>
                  {expandedDeployLog && deployLog.length > 0 && (
                    <div className="border-t bg-black/50 p-4 max-h-80 overflow-auto font-mono text-xs leading-5">
                      {deployLog.map((line, i) => (
                        <div
                          key={i}
                          className="text-zinc-300"
                          dangerouslySetInnerHTML={{ __html: highlightLogLine(line) }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {project.deployments.map((deployment, idx) => {
                const isActive = deployment.status === "success" && project.status === "active" && idx === 0;
                const isStopped = deployment.status === "success" && project.status === "stopped" && idx === 0;
                const isErrored = deployment.status === "success" && project.status === "error" && idx === 0;
                const bgColor = isActive
                  ? "bg-status-success-muted"
                  : isStopped
                  ? "bg-status-neutral-muted"
                  : isErrored
                  ? "bg-status-error-muted"
                  : {
                      success: "bg-card",
                      failed: "bg-status-error-muted",
                      running: "bg-status-info-muted",
                      queued: "bg-status-neutral-muted",
                      cancelled: "bg-status-neutral-muted",
                    }[deployment.status] || "bg-card";

                return (
                <div key={deployment.id} className={`squircle rounded-lg border ${bgColor} overflow-hidden`}>
                  <button
                    type="button"
                    onClick={() => setViewingLogId(viewingLogId === deployment.id ? null : deployment.id)}
                    className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {isActive ? (
                        <Badge className="border-transparent bg-status-success text-white shrink-0">
                          <span className="mr-1.5 size-1.5 rounded-full bg-white animate-pulse" />
                          Live
                        </Badge>
                      ) : isStopped ? (
                        <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                          Stopped
                        </Badge>
                      ) : isErrored ? (
                        <Badge className="border-transparent bg-status-error-muted text-status-error shrink-0">
                          Crashed
                        </Badge>
                      ) : deployment.status === "success" && idx > 0 && project.status === "active" ? (
                        <Badge className="border-transparent bg-status-neutral-muted text-status-neutral shrink-0">
                          Superseded
                        </Badge>
                      ) : (
                        <DeploymentStatusBadge status={deployment.status} />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">
                            {deployment.gitMessage || (
                              isActive ? (
                                <>
                                  <span className="capitalize">{deployment.trigger}</span>
                                  <span className="text-muted-foreground font-normal"> deploy</span>
                                </>
                              ) : (
                                <span className="capitalize">{deployment.trigger}</span>
                              )
                            )}
                          </p>
                          {deployment.gitSha && (
                            <code className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                              {deployment.gitSha.slice(0, 7)}
                            </code>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {(() => {
                            const triggerLabel = {
                              manual: "Manual deploy",
                              webhook: "Auto deploy",
                              api: "API deploy",
                              rollback: "Rollback",
                            }[deployment.trigger];
                            const by = deployment.triggeredByUser?.name;
                            return by ? `${triggerLabel} by ${by}` : triggerLabel;
                          })()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                      {isActive && deployment.finishedAt && (
                        <span className="text-status-success">
                          <Uptime since={deployment.finishedAt} />
                        </span>
                      )}
                      {deployment.durationMs != null && (
                        <span>built in {formatDuration(deployment.durationMs)}</span>
                      )}
                      <span>
                        {new Date(deployment.startedAt).toLocaleDateString()}
                      </span>
                      <ChevronDown className={`size-4 transition-transform ${viewingLogId === deployment.id ? "rotate-180" : ""}`} />
                    </div>
                  </button>
                  {viewingLogId === deployment.id && deployment.log && (
                    <div className="border-t bg-black/50 p-4 max-h-80 overflow-auto font-mono text-xs leading-5">
                      {deployment.log.split("\n").map((line, i) => (
                        <div
                          key={i}
                          className="text-zinc-300"
                          dangerouslySetInnerHTML={{ __html: highlightLogLine(line) }}
                        />
                      ))}
                    </div>
                  )}
                  {viewingLogId === deployment.id && !deployment.log && (
                    <div className="border-t p-4">
                      <p className="text-xs text-muted-foreground">No log output for this deployment.</p>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="variables" className="pt-4">
          <EnvEditor
            projectId={project.id}
            orgId={orgId}
            initialVars={project.envVars}
            allProjectNames={allProjectNames}
            orgVarKeys={orgVarKeys}
          />
        </TabsContent>

        <TabsContent value="domains" className="space-y-4 pt-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setNewDomain("");
                setNewDomainPort("");
                setDomainOpen(true);
              }}
            >
              <Plus className="mr-1.5 size-4" />
              Add Domain
            </Button>
          </div>

          {project.domains.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No domains configured.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {project.domains
                .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
                .map((domain) => (
                <div
                  key={domain.id}
                  className={`squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4 ${domain.isPrimary ? "border-primary/30" : ""}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <p className="text-sm font-medium font-mono truncate">
                      {domain.domain}
                    </p>
                    {domain.isPrimary && (
                      <Badge className="text-xs border-transparent bg-status-info-muted text-status-info shrink-0">
                        Primary
                      </Badge>
                    )}
                    {domain.port && (
                      <span className="text-xs text-muted-foreground">:{domain.port}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {!domain.isPrimary && (
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Set as primary"
                        onClick={() => handleSetPrimaryDomain(domain.id)}
                      >
                        <Star className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={deletingDomainId === domain.id}
                      onClick={() => handleDomainDelete(domain.id)}
                    >
                      {deletingDomainId === domain.id ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <X className="size-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <LogViewer
            streamUrl={`/api/v1/organizations/${orgId}/projects/${project.id}/logs/stream`}
          />
        </TabsContent>

        <TabsContent value="volumes" className="pt-4">
          <VolumesPanel projectId={project.id} orgId={orgId} />
        </TabsContent>

        <TabsContent value="terminal" className="pt-4">
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
            <Terminal className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Web terminal coming soon.
            </p>
            <p className="text-xs text-muted-foreground">
              Open a shell directly into your running containers.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
            <p className="text-sm text-muted-foreground">
              Container metrics coming soon.
            </p>
            <p className="text-xs text-muted-foreground">
              CPU, memory, network, and disk usage for each container.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="environments" className="space-y-4 pt-4">
          {project.environments.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No additional environments. This project runs in production by default.
              </p>
              <p className="text-xs text-muted-foreground">
                Add staging or preview environments to test changes before deploying to production.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {project.environments.map((env) => (
                <div
                  key={env.id}
                  className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <p className="text-sm font-medium">{env.name}</p>
                    <Badge variant="secondary" className="text-xs">
                      {env.type}
                    </Badge>
                  </div>
                  {env.domain && (
                    <span className="text-xs text-muted-foreground font-mono truncate">
                      {env.domain}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Edit Bottom Sheet */}
      <BottomSheet open={editOpen} onOpenChange={setEditOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Edit project</BottomSheetTitle>
            <BottomSheetDescription>
              Update project configuration.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-4">
              {/* Name + Description */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="edit-display-name">Display Name</Label>
                  <Input
                    id="edit-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="edit-description">Description</Label>
                  <Input
                    id="edit-description"
                    placeholder="Optional"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>

              {/* Source settings */}
              {project.source === "git" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label htmlFor="edit-git-branch">Branch</Label>
                    <Input
                      id="edit-git-branch"
                      value={gitBranch}
                      onChange={(e) => setGitBranch(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="edit-root-directory">Root Directory</Label>
                    <Input
                      id="edit-root-directory"
                      placeholder="./"
                      value={rootDirectory}
                      onChange={(e) => setRootDirectory(e.target.value)}
                    />
                  </div>
                </div>
              )}

              {/* Port */}
              <div className="grid gap-2 sm:w-1/2">
                <Label>Container Port</Label>
                <div className="flex items-center gap-3">
                  <Switch
                    id="edit-auto-port"
                    checked={autoPort}
                    onCheckedChange={(checked) => {
                      setAutoPort(checked);
                      if (checked) setContainerPort("");
                    }}
                  />
                  <Label htmlFor="edit-auto-port" className="text-sm font-normal text-muted-foreground">
                    Auto-detect
                  </Label>
                  {!autoPort && (
                    <Input
                      id="edit-container-port"
                      type="number"
                      placeholder="3000"
                      className="w-24"
                      value={containerPort}
                      onChange={(e) => setContainerPort(e.target.value)}
                    />
                  )}
                </div>
              </div>

              {/* Toggles */}
              <div className="grid gap-3">
                <div className="flex items-center gap-3">
                  <Switch
                    id="edit-auto-deploy"
                    checked={autoDeploy}
                    onCheckedChange={setAutoDeploy}
                  />
                  <Label htmlFor="edit-auto-deploy">Auto Deploy</Label>
                </div>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setEditOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Add Domain Bottom Sheet */}
      <BottomSheet
        open={domainOpen}
        onOpenChange={(v) => {
          setDomainOpen(v);
          if (!v) { setNewDomain(""); setNewDomainPort(""); }
        }}
      >
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Add domain</BottomSheetTitle>
            <BottomSheetDescription>
              Point a custom domain to this project. Make sure your DNS is configured first.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="new-domain">Domain</Label>
                <Input
                  id="new-domain"
                  placeholder="app.example.com"
                  className="font-mono"
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                />
              </div>
              <div className="grid gap-2 sm:w-1/3">
                <Label htmlFor="new-domain-port">Port</Label>
                <Input
                  id="new-domain-port"
                  type="number"
                  placeholder={project.containerPort?.toString() || "3000"}
                  value={newDomainPort}
                  onChange={(e) => setNewDomainPort(e.target.value)}
                />
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setDomainOpen(false)}
              disabled={domainSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDomainAdd}
              disabled={domainSaving || !newDomain.trim()}
            >
              {domainSaving ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Adding...</>
              ) : (
                "Add Domain"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Delete Confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete project"
        description={`Are you sure you want to delete "${project.displayName}"? This will remove all deployments, domains, and environment variables. This action cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />
    </div>
  );
}

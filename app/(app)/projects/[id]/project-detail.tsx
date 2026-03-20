"use client";

import { useState, useCallback } from "react";
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
import { LogViewer } from "@/components/log-viewer";
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
  durationMs: number | null;
  log: string | null;
  startedAt: Date;
  finishedAt: Date | null;
};

type Domain = {
  id: string;
  domain: string;
  serviceName: string | null;
  port: number | null;
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
        <Badge className="border-transparent bg-green-500/15 text-green-700 dark:text-green-400">
          Active
        </Badge>
      );
    case "deploying":
      return (
        <Badge variant="outline" className="animate-pulse">
          Deploying
        </Badge>
      );
    case "error":
      return <Badge variant="destructive">Error</Badge>;
    default:
      return <Badge variant="secondary">Stopped</Badge>;
  }
}

function DeploymentStatusBadge({ status }: { status: Deployment["status"] }) {
  switch (status) {
    case "success":
      return (
        <Badge className="border-transparent bg-green-500/15 text-green-700 dark:text-green-400">
          Success
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="animate-pulse">
          Running
        </Badge>
      );
    case "failed":
      return <Badge variant="destructive">Failed</Badge>;
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
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
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

  async function handleDeploy() {
    setDeploying(true);
    setActiveTab("deployments");
    setDeployLog([]);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/deploy`,
        { method: "POST" }
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
    } catch {
      toast.error("Deployment failed");
    } finally {
      setDeploying(false);
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
                  <Button size="sm" className="bg-green-600 hover:bg-green-700 text-white">
                    <span className="mr-1.5 size-2 rounded-full bg-green-300 animate-pulse" />
                    Running
                    {(() => {
                      const lastDeploy = project.deployments.find((d) => d.status === "success");
                      return lastDeploy ? (
                        <span className="ml-1.5 text-green-200 text-xs font-normal">
                          {formatUptime(lastDeploy.finishedAt || lastDeploy.startedAt)}
                        </span>
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
          {/* Live deploy output */}
          {deploying && deployLog.length > 0 && (
            <div className="rounded-lg border bg-black/80 p-4 max-h-80 overflow-auto">
              <div className="flex items-center gap-2 mb-2">
                <Loader2 className="size-3.5 animate-spin text-blue-400" />
                <span className="text-xs text-blue-400 font-medium">Deploying...</span>
              </div>
              <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap">
                {deployLog.join("\n")}
              </pre>
            </div>
          )}

          {project.deployments.length === 0 && !deploying ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No deployments yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {project.deployments.map((deployment) => (
                <div key={deployment.id} className="squircle rounded-lg border bg-card overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setViewingLogId(viewingLogId === deployment.id ? null : deployment.id)}
                    className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <DeploymentStatusBadge status={deployment.status} />
                      <div className="min-w-0">
                        <p className="text-sm font-medium capitalize">
                          {deployment.trigger}
                        </p>
                        {deployment.gitSha && (
                          <p className="truncate text-xs text-muted-foreground font-mono">
                            {deployment.gitSha.slice(0, 7)}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground shrink-0">
                      {deployment.durationMs != null && (
                        <span>{formatDuration(deployment.durationMs)}</span>
                      )}
                      <span>
                        {new Date(deployment.startedAt).toLocaleString()}
                      </span>
                      <ChevronDown className={`size-4 transition-transform ${viewingLogId === deployment.id ? "rotate-180" : ""}`} />
                    </div>
                  </button>
                  {viewingLogId === deployment.id && deployment.log && (
                    <div className="border-t bg-black/50 p-4 max-h-80 overflow-auto">
                      <pre className="text-xs font-mono text-green-400 whitespace-pre-wrap">
                        {deployment.log}
                      </pre>
                    </div>
                  )}
                  {viewingLogId === deployment.id && !deployment.log && (
                    <div className="border-t p-4">
                      <p className="text-xs text-muted-foreground">No log output for this deployment.</p>
                    </div>
                  )}
                </div>
              ))}
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
              {project.domains.map((domain) => (
                <div
                  key={domain.id}
                  className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <p className="text-sm font-medium font-mono truncate">
                      {domain.domain}
                    </p>
                    {domain.port && (
                      <span className="text-xs text-muted-foreground">:{domain.port}</span>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive shrink-0"
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
            <div className="grid gap-4 py-4">
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
                <Textarea
                  id="edit-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={2}
                />
              </div>

              {project.source === "git" && (
                <div className="grid gap-2">
                  <Label htmlFor="edit-git-branch">Branch</Label>
                  <Input
                    id="edit-git-branch"
                    value={gitBranch}
                    onChange={(e) => setGitBranch(e.target.value)}
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="edit-root-directory">Root Directory</Label>
                <Input
                  id="edit-root-directory"
                  placeholder="./ (optional)"
                  value={rootDirectory}
                  onChange={(e) => setRootDirectory(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Subdirectory for build context, e.g. ./dist or ./apps/web
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="edit-container-port">Container Port</Label>
                <Input
                  id="edit-container-port"
                  type="number"
                  placeholder="3000"
                  value={containerPort}
                  onChange={(e) => setContainerPort(e.target.value)}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="edit-auto-traefik">Auto Traefik Labels</Label>
                <Switch
                  id="edit-auto-traefik"
                  checked={autoTraefikLabels}
                  onCheckedChange={setAutoTraefikLabels}
                />
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="edit-auto-deploy">Auto Deploy</Label>
                <Switch
                  id="edit-auto-deploy"
                  checked={autoDeploy}
                  onCheckedChange={setAutoDeploy}
                />
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

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  BottomSheet,
  BottomSheetContent,
  BottomSheetFooter,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetDescription,
} from "@/components/ui/bottom-sheet";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";

type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  trigger: "manual" | "webhook" | "api" | "rollback";
  gitSha: string | null;
  durationMs: number | null;
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
};

type ProjectDetailProps = {
  project: Project;
  orgId: string;
  userRole: string;
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

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

export function ProjectDetail({ project, orgId, userRole }: ProjectDetailProps) {
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

  // Env var state
  const [envVarOpen, setEnvVarOpen] = useState(false);
  const [envVarSaving, setEnvVarSaving] = useState(false);
  const [envVarKey, setEnvVarKey] = useState("");
  const [envVarValue, setEnvVarValue] = useState("");
  const [envVarIsSecret, setEnvVarIsSecret] = useState(true);
  const [editingEnvVarId, setEditingEnvVarId] = useState<string | null>(null);
  const [deletingEnvVarId, setDeletingEnvVarId] = useState<string | null>(null);

  // Bulk edit state
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkContent, setBulkContent] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  // Domain state
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainSaving, setDomainSaving] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [deletingDomainId, setDeletingDomainId] = useState<string | null>(null);

  const [deploying, setDeploying] = useState(false);

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

  function resetEnvVarForm() {
    setEnvVarKey("");
    setEnvVarValue("");
    setEnvVarIsSecret(true);
    setEditingEnvVarId(null);
  }

  async function handleEnvVarSave() {
    setEnvVarSaving(true);
    try {
      const url = `/api/v1/organizations/${orgId}/projects/${project.id}/env-vars`;

      if (editingEnvVarId) {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingEnvVarId, value: envVarValue }),
        });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error || "Failed to update variable");
          return;
        }
        toast.success("Variable updated");
      } else {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            key: envVarKey.trim(),
            value: envVarValue,
            isSecret: envVarIsSecret,
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          toast.error(data.error || "Failed to add variable");
          return;
        }
        toast.success("Variable added");
      }

      setEnvVarOpen(false);
      resetEnvVarForm();
      router.refresh();
    } catch {
      toast.error("Failed to save variable");
    } finally {
      setEnvVarSaving(false);
    }
  }

  async function handleEnvVarDelete(id: string) {
    setDeletingEnvVarId(id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/env-vars`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete variable");
        return;
      }
      toast.success("Variable deleted");
      router.refresh();
    } catch {
      toast.error("Failed to delete variable");
    } finally {
      setDeletingEnvVarId(null);
    }
  }

  async function handleBulkSave() {
    setBulkSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${project.id}/env-vars`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: bulkContent }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to save variables");
        return;
      }

      const data = await res.json();
      toast.success(
        `${data.created} added, ${data.updated} updated`
      );
      setBulkEditOpen(false);
      setBulkContent("");
      router.refresh();
    } catch {
      toast.error("Failed to save variables");
    } finally {
      setBulkSaving(false);
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
            <Button
              size="sm"
              disabled={deploying}
              onClick={async () => {
                setDeploying(true);
                try {
                  const res = await fetch(
                    `/api/v1/organizations/${orgId}/projects/${project.id}/deploy`,
                    { method: "POST" }
                  );
                  const data = await res.json();
                  if (data.success) {
                    toast.success(`Deployed in ${data.durationMs}ms`);
                  } else {
                    toast.error("Deployment failed");
                  }
                  router.refresh();
                } catch {
                  toast.error("Deployment failed");
                } finally {
                  setDeploying(false);
                }
              }}
            >
              {deploying ? (
                <><Loader2 className="mr-1.5 size-4 animate-spin" />Deploying...</>
              ) : (
                <><Rocket className="mr-1.5 size-4" />Deploy</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/restart`, { method: "POST" });
                const data = await res.json();
                data.success ? toast.success("Restarted") : toast.error("Restart failed");
                router.refresh();
              }}
            >
              <RotateCcw className="mr-1.5 size-4" />
              Restart
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                const res = await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/stop`, { method: "POST" });
                const data = await res.json();
                data.success ? toast.success("Stopped") : toast.error("Stop failed");
                router.refresh();
              }}
            >
              <Square className="mr-1.5 size-4" />
              Stop
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => toast.info("Terminal not yet implemented")}
            >
              <Terminal className="mr-1.5 size-4" />
              Terminal
            </Button>
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
      <Tabs defaultValue="deployments">
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
          <TabsTrigger value="environments">
            Environments
            {project.environments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {project.environments.length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="deployments" className="pt-4">
          {project.deployments.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No deployments yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {project.deployments.map((deployment) => (
                <div
                  key={deployment.id}
                  className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
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
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="variables" className="space-y-4 pt-4">
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBulkContent("");
                setBulkEditOpen(true);
              }}
            >
              <FileText className="mr-1.5 size-4" />
              Bulk Edit
            </Button>
            <Button
              size="sm"
              onClick={() => {
                resetEnvVarForm();
                setEnvVarOpen(true);
              }}
            >
              <Plus className="mr-1.5 size-4" />
              Add Variable
            </Button>
          </div>

          {project.envVars.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No environment variables configured.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {project.envVars.map((envVar) => (
                <div
                  key={envVar.id}
                  className="squircle flex items-center justify-between gap-4 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <p className="text-sm font-medium font-mono">
                      {envVar.key}
                    </p>
                    {envVar.isSecret && (
                      <EyeOff className="size-3.5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditingEnvVarId(envVar.id);
                        setEnvVarKey(envVar.key);
                        setEnvVarValue("");
                        setEnvVarIsSecret(envVar.isSecret ?? true);
                        setEnvVarOpen(true);
                      }}
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={deletingEnvVarId === envVar.id}
                      onClick={() => handleEnvVarDelete(envVar.id)}
                    >
                      {deletingEnvVarId === envVar.id ? (
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

      {/* Add/Edit Variable Bottom Sheet */}
      <BottomSheet
        open={envVarOpen}
        onOpenChange={(v) => {
          setEnvVarOpen(v);
          if (!v) resetEnvVarForm();
        }}
      >
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>
              {editingEnvVarId ? "Update variable" : "Add variable"}
            </BottomSheetTitle>
            <BottomSheetDescription>
              {editingEnvVarId
                ? `Set a new value for ${envVarKey}.`
                : "Add an environment variable to this project."}
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-4 py-4">
              {!editingEnvVarId && (
                <div className="grid gap-2">
                  <Label htmlFor="env-key">Key</Label>
                  <Input
                    id="env-key"
                    placeholder="DATABASE_URL"
                    className="font-mono"
                    value={envVarKey}
                    onChange={(e) =>
                      setEnvVarKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))
                    }
                  />
                </div>
              )}

              <div className="grid gap-2">
                <Label htmlFor="env-value">Value</Label>
                <Textarea
                  id="env-value"
                  placeholder={editingEnvVarId ? "Enter new value" : "Enter value"}
                  className="font-mono text-sm"
                  value={envVarValue}
                  onChange={(e) => setEnvVarValue(e.target.value)}
                  rows={3}
                />
                {envVarValue.includes("${") && (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Variable className="size-3" />
                    Contains variable references — resolved at deploy time
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Use <code className="bg-muted px-1 py-0.5 rounded">{"${VAR}"}</code> for self-refs,{" "}
                  <code className="bg-muted px-1 py-0.5 rounded">{"${project.name}"}</code> for built-ins,{" "}
                  <code className="bg-muted px-1 py-0.5 rounded">{"${postgres.DB_URL}"}</code> for cross-project
                </p>
              </div>

              {!editingEnvVarId && (
                <div className="flex items-center justify-between">
                  <Label htmlFor="env-secret">Secret</Label>
                  <Switch
                    id="env-secret"
                    checked={envVarIsSecret}
                    onCheckedChange={setEnvVarIsSecret}
                  />
                </div>
              )}
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setEnvVarOpen(false)}
              disabled={envVarSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleEnvVarSave}
              disabled={
                envVarSaving ||
                (!editingEnvVarId && !envVarKey.trim()) ||
                !envVarValue
              }
            >
              {envVarSaving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : editingEnvVarId ? (
                "Update"
              ) : (
                "Add Variable"
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

      {/* Bulk Edit Bottom Sheet */}
      <BottomSheet
        open={bulkEditOpen}
        onOpenChange={(v) => {
          setBulkEditOpen(v);
          if (!v) setBulkContent("");
        }}
      >
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Bulk edit variables</BottomSheetTitle>
            <BottomSheetDescription>
              Paste environment variables in KEY=value format, one per line.
              Existing variables with matching keys will be updated.
              Supports variable references like{" "}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                {"${postgres.POSTGRES_PASSWORD}"}
              </code>
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <Textarea
              placeholder={"DATABASE_URL=postgres://localhost:5432/mydb\nREDIS_URL=redis://localhost:6379\nSECRET_KEY=changeme\n\n# References to other projects\nDB_PASSWORD=${postgres.POSTGRES_PASSWORD}"}
              className="font-mono text-sm min-h-[300px]"
              value={bulkContent}
              onChange={(e) => setBulkContent(e.target.value)}
            />
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => setBulkEditOpen(false)}
              disabled={bulkSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleBulkSave}
              disabled={bulkSaving || !bulkContent.trim()}
            >
              {bulkSaving ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save All"
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

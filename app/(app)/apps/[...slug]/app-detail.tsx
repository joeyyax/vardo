"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  Pencil,
  Trash2,
  Loader2,
  Plus,
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
  Copy,
  Container,
  Info,
  EllipsisVertical,
  Layers,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogViewer, DeploymentLog, TerminalOutput, highlightLogLine, detectLogLevel } from "@/components/log-viewer";
import dynamic from "next/dynamic";
import { detectAppType } from "@/lib/ui/app-type";
import { AppMetrics } from "./app-metrics";

const AppTerminal = dynamic(
  () => import("./app-terminal").then((m) => m.AppTerminal),
  { ssr: false },
);
import { EnvEditor } from "@/components/env-editor";
import { VolumesPanel } from "@/components/volumes-panel";
import { CronManager } from "./app-cron";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isAdmin } from "@/lib/auth/permissions";
import { BranchSelect } from "@/components/branch-select";

type Deployment = {
  id: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  trigger: "manual" | "webhook" | "api" | "rollback";
  gitSha: string | null;
  gitMessage: string | null;
  durationMs: number | null;
  log: string | null;
  environmentId: string | null;
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
  value: string;
  isSecret: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

type Environment = {
  id: string;
  name: string;
  type: "production" | "staging" | "preview";
  domain: string | null;
  gitBranch: string | null;
  isDefault: boolean | null;
  createdAt: Date;
};

type App = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  source: "git" | "direct";
  deployType: "compose" | "dockerfile" | "image" | "static" | "nixpacks";
  gitUrl: string | null;
  gitBranch: string | null;
  imageName: string | null;
  composeFilePath: string | null;
  rootDirectory: string | null;
  containerPort: number | null;
  autoTraefikLabels: boolean | null;
  autoDeploy: boolean | null;
  restartPolicy: string | null;
  connectionInfo: { label: string; value: string; copyRef?: string }[] | null;
  exposedPorts: { internal: number; external?: number; description?: string }[] | null;
  projectId: string | null;
  cloneStrategy: string | null;
  dependsOn: string[] | null;
  status: "active" | "stopped" | "error" | "deploying";
  needsRedeploy: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  deployments: Deployment[];
  domains: Domain[];
  envVars: EnvVar[];
  environments: Environment[];
  appTags?: { tag: Tag }[];
  project?: { id: string; name: string; displayName: string; color: string | null } | null;
};

type Tag = {
  id: string;
  name: string;
  color: string;
};

type AppDetailProps = {
  app: App;
  orgId: string;
  userRole: string;
  allTags?: Tag[];
  allParentApps?: { id: string; name: string; color: string }[];
  allAppNames?: string[];
  orgVarKeys?: string[];
  siblings?: { name: string; displayName: string; status: string }[];
  initialTab?: string;
  initialEnv?: string;
  initialSubView?: string;
};

function statusDotColor(status: string) {
  return status === "active" ? "bg-status-success"
    : status === "error" ? "bg-status-error"
    : "bg-status-neutral";
}

function envTypeDotColor(type: string) {
  return type === "production" ? "bg-status-success"
    : type === "staging" ? "bg-status-warning"
    : "bg-status-info";
}

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

function PortsManager({
  ports: initialPorts,
  appId,
  orgId,
}: {
  ports: { internal: number; external?: number; protocol?: string; description?: string }[];
  appId: string;
  orgId: string;
}) {
  const router = useRouter();
  const [ports, setPorts] = useState(initialPorts);
  const [adding, setAdding] = useState(false);
  const [newInternal, setNewInternal] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function savePorts(updated: typeof ports) {
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exposedPorts: updated }),
      });
      if (!res.ok) {
        toast.error("Failed to update ports");
        return;
      }
      setPorts(updated);
      toast.success("Ports updated — redeploy to apply");
      router.refresh();
    } catch {
      toast.error("Failed to update ports");
    } finally {
      setSaving(false);
    }
  }

  function handleAdd() {
    const internal = parseInt(newInternal);
    if (!internal || internal < 1 || internal > 65535) {
      toast.error("Enter a valid port number (1-65535)");
      return;
    }
    const updated = [...ports, { internal, description: newDescription || undefined }];
    savePorts(updated);
    setAdding(false);
    setNewInternal("");
    setNewDescription("");
  }

  function handleRemove(index: number) {
    const updated = ports.filter((_, i) => i !== index);
    savePorts(updated);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Exposed Ports</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Map container ports to host ports for external access.</p>
        </div>
        <Button size="sm" onClick={() => setAdding(!adding)} disabled={saving}>
          <Plus className="mr-1.5 size-4" />
          Add Port
        </Button>
      </div>

      {adding && (
        <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">Container Port</label>
            <input
              type="number"
              placeholder="8080"
              value={newInternal}
              onChange={(e) => setNewInternal(e.target.value)}
              className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">Host Port</label>
            <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm font-mono text-muted-foreground">
              Auto
            </div>
          </div>
          <div className="grid gap-1.5 flex-1">
            <label className="text-xs text-muted-foreground">Label <span className="text-muted-foreground/60">(optional)</span></label>
            <input
              placeholder="e.g. HTTP, Database"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <Button size="sm" onClick={handleAdd} disabled={saving || !newInternal}>
            Add
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}

      {ports.length === 0 && !adding ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
          <p className="text-sm text-muted-foreground">
            No ports exposed. Container ports are only accessible within the Docker network.
          </p>
        </div>
      ) : ports.length > 0 && (
        <div className="divide-y rounded-lg border">
          {ports.map((port, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex items-center gap-4">
                <span className="text-sm font-mono">{port.internal}</span>
                <span className="text-xs text-muted-foreground">→</span>
                <span className="text-sm font-mono">
                  {port.external ? `localhost:${port.external}` : <span className="text-muted-foreground">Auto-assigned</span>}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {port.description && (
                  <span className="text-xs text-muted-foreground">{port.description}</span>
                )}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleRemove(i)}
                  disabled={saving}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function InProgressDeployCard({
  stages,
  log,
  startTime,
  expanded,
  onToggleExpand,
  onAbort,
  canAbort,
  trigger,
}: {
  stages: Record<string, "running" | "success" | "failed" | "skipped">;
  log: string[];
  startTime: number | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onAbort?: () => void;
  canAbort?: boolean;
  trigger?: string;
}) {
  const stageLabels: Record<string, string> = {
    clone: "Clone", build: "Build", deploy: "Deploy",
    healthcheck: "Health", routing: "Route", cleanup: "Cleanup",
  };
  const stageKeys = ["clone", "build", "deploy", "healthcheck", "routing", "cleanup"] as const;
  const hasStages = Object.keys(stages).length > 0;

  return (
    <div className="squircle rounded-lg border bg-status-info-muted overflow-hidden">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggleExpand}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onToggleExpand(); }}
        className="flex items-center justify-between gap-4 p-4 w-full text-left hover:bg-accent/50 transition-colors cursor-pointer"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Badge variant="outline" className="animate-pulse shrink-0">
            <Loader2 className="mr-1 size-3 animate-spin" />
            Deploying
          </Badge>
          {hasStages ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {stageKeys.map((s, i) => {
                const status = stages[s];
                if (!status) return null;
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
                      {stageLabels[s]}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : trigger && (
            <span className="text-xs text-foreground/60 capitalize">{trigger} deploy in progress...</span>
          )}
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {startTime && (
            <Timer since={startTime} className="text-xs text-foreground/50" />
          )}
          {canAbort && onAbort && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={(e) => { e.stopPropagation(); onAbort(); }}
            >
              <Square className="mr-1 size-3" />
              Abort
            </Button>
          )}
          {log.length > 0 && (
            <ChevronDown className={`size-4 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
          )}
        </div>
      </div>
      {expanded && log.length > 0 && (
        <div className="border-t">
          <TerminalOutput
            lines={log.map((text) => ({ text, html: highlightLogLine(text), level: detectLogLevel(text) }))}
            height="max-h-80"
            showFilters={false}
          />
        </div>
      )}
    </div>
  );
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

function buildAppPath(appName: string, environments: Environment[], envId: string | undefined, tab?: string) {
  const env = environments.find((e) => e.id === envId);
  const envSegment = env && env.type !== "production" ? `/${env.name}` : "";
  const base = `/apps/${appName}${envSegment}`;
  return tab && tab !== "deployments" ? `${base}/${tab}` : base;
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

export function AppDetail({ app, orgId, userRole, allTags = [], allParentApps = [], allAppNames = [], orgVarKeys = [], siblings = [], initialTab = "deployments", initialEnv, initialSubView }: AppDetailProps) {
  const router = useRouter();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteEnvOpen, setDeleteEnvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingEnv, setDeletingEnv] = useState(false);

  // Edit form state
  const [displayName, setDisplayName] = useState(app.displayName);
  const [description, setDescription] = useState(app.description || "");
  const [containerPort, setContainerPort] = useState(
    app.containerPort?.toString() || ""
  );
  const [autoPort, setAutoPort] = useState(!app.containerPort);
  const [editImageName, setEditImageName] = useState(app.imageName || "");
  const [restartPolicy, setRestartPolicy] = useState(app.restartPolicy || "unless-stopped");
  const [autoTraefikLabels, setAutoTraefikLabels] = useState(
    app.autoTraefikLabels ?? false
  );
  const [autoDeploy, setAutoDeploy] = useState(app.autoDeploy ?? false);
  const [gitBranch, setGitBranch] = useState(app.gitBranch || "");
  const [rootDirectory, setRootDirectory] = useState(app.rootDirectory || "");
  const [editParentId, setEditParentId] = useState<string | null>(app.projectId ?? null);

  // New environment form state
  const [newEnvOpen, setNewEnvOpen] = useState(false);
  const [newEnvName, setNewEnvName] = useState("");
  const [newEnvType, setNewEnvType] = useState<"staging" | "preview">("staging");
  const [newEnvCloneFrom, setNewEnvCloneFrom] = useState<string>("__production");
  const [newEnvBranch, setNewEnvBranch] = useState("");
  const [newEnvSaving, setNewEnvSaving] = useState(false);

  async function handleCreateEnv() {
    const name = newEnvName.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (!name) return;
    setNewEnvSaving(true);
    try {
      const cloneFrom = newEnvCloneFrom === "__none" ? undefined
        : newEnvCloneFrom === "__production" ? productionEnv?.id
        : newEnvCloneFrom;
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/environments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            type: newEnvType,
            cloneFrom,
            gitBranch: newEnvBranch.trim() || undefined,
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const newEnvId = data.environment.id;
        setSelectedEnvId(newEnvId);
        setNewEnvOpen(false);
        setNewEnvName("");
        setNewEnvBranch("");
        setNewEnvCloneFrom("__production");
        router.refresh();

        // Auto-deploy the new environment
        toast.success(`Environment "${name}" created — deploying...`);
        fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/deploy`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: newEnvId }),
        }).catch(() => {
          toast.error("Auto-deploy failed");
        });
      } else {
        const data = await res.json();
        if (data.error?.includes("already exists")) {
          const existing = app.environments.find((e) => e.name === name);
          if (existing) setSelectedEnvId(existing.id);
          setNewEnvOpen(false);
          toast.info("Environment already exists");
        } else {
          toast.error(data.error || "Failed to create environment");
        }
      }
    } catch {
      toast.error("Failed to create environment");
    } finally {
      setNewEnvSaving(false);
    }
  }

  // Domain state
  const [domainOpen, setDomainOpen] = useState(false);
  const [domainSaving, setDomainSaving] = useState(false);
  const [newDomain, setNewDomain] = useState("");
  const [newDomainPort, setNewDomainPort] = useState("");
  const [deletingDomainId, setDeletingDomainId] = useState<string | null>(null);
  const [editingDomainId, setEditingDomainId] = useState<string | null>(null);
  const [editDomainValue, setEditDomainValue] = useState("");
  const [editDomainPort, setEditDomainPort] = useState("");
  const [dnsDomainId, setDnsDomainId] = useState<string | null>(null);
  const [domainStatuses, setDomainStatuses] = useState<Record<string, "checking" | "resolving" | "not-configured">>({});
  const [domainCheckTick, setDomainCheckTick] = useState(0);
  const [serverIP, setServerIP] = useState<string | null>(null);

  function openDomainSheet(domainId: string) {
    setDnsDomainId(domainId);
    const domain = app.domains.find((d) => d.id === domainId);
    if (domain) {
      window.history.replaceState({}, "", `/apps/${app.name}/networking/${domain.domain}`);
    }
  }

  // Open sub-view from URL (e.g. /apps/emmayax/networking/emmayax.com)
  useEffect(() => {
    if (!initialSubView) return;
    if (initialTab === "networking") {
      const domain = app.domains.find((d) => d.domain === initialSubView);
      if (domain) {
        setDnsDomainId(domain.id);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [deploying, setDeploying] = useState(false);
  const [showVarNames, setShowVarNames] = useState(false);
  // Environment selection — persist via URL path segment (/apps/{slug}/{env}/{tab})
  const productionEnv = app.environments.find((e) => e.type === "production");
  const initialEnvId = (() => {
    if (initialEnv) {
      const match = app.environments.find((e) => e.name === initialEnv);
      if (match) return match.id;
    }
    return productionEnv?.id;
  })();
  const [selectedEnvId, setSelectedEnvIdRaw] = useState<string | undefined>(initialEnvId);
  const [activeTab, setActiveTabState] = useState(initialTab);

  // Wrap setSelectedEnvId to also update URL path
  const setSelectedEnvId = useCallback((envId: string | undefined) => {
    setSelectedEnvIdRaw(envId);
    window.history.replaceState({}, "", buildAppPath(app.name, app.environments, envId, activeTab));
  }, [app.environments, app.name, activeTab]);

  const selectedEnv = app.environments.find((e) => e.id === selectedEnvId)
    ?? productionEnv;
  // If selectedEnvId doesn't match any environment, reset to production
  useEffect(() => {
    if (selectedEnvId && !app.environments.find((e) => e.id === selectedEnvId)) {
      setSelectedEnvId(productionEnv?.id);
    }
  }, [selectedEnvId, app.environments, productionEnv?.id, setSelectedEnvId]);

  const isProduction = !selectedEnv || selectedEnv.type === "production";
  // Filter deployments by selected environment
  // Legacy deploys (environmentId=null) only show under production
  const filteredDeployments = selectedEnvId
    ? app.deployments.filter((d) =>
        d.environmentId === selectedEnvId ||
        (isProduction && d.environmentId === null)
      )
    : app.deployments;
  const [viewingLogId, setViewingLogId] = useState<string | null>(null);
  const searchParams = useSearchParams();

  // Check domain resolution status via server-side API
  const checkAllDomains = useCallback(async () => {
    if (app.domains.length === 0) return;
    const autoDomain = app.domains.find((d) => d.domain.endsWith(".localhost"))?.domain;

    for (const domain of app.domains) {
      setDomainStatuses((prev) => ({ ...prev, [domain.id]: "checking" }));
      try {
        const params = new URLSearchParams({ domain: domain.domain });
        if (autoDomain && autoDomain !== domain.domain) {
          params.set("expected", autoDomain);
        }
        const res = await fetch(`/api/v1/dns-check?${params}`);
        const data = await res.json();
        setDomainStatuses((prev) => ({
          ...prev,
          [domain.id]: data.configured ? "resolving" : "not-configured",
        }));
        if (data.serverIPs?.length) {
          setServerIP(data.serverIPs[0]);
        }
      } catch {
        setDomainStatuses((prev) => ({ ...prev, [domain.id]: "not-configured" }));
      }
    }
  }, [app.domains]);

  // Initial check + re-check on tick
  useEffect(() => {
    checkAllDomains();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.domains.length, domainCheckTick]);

  // Background re-check every 30s while on the networking tab
  useEffect(() => {
    if (activeTab !== "networking") return;
    const interval = setInterval(() => checkAllDomains(), 30000);
    return () => clearInterval(interval);
  }, [activeTab, checkAllDomains]);

  // Detect in-progress deployment from server data (arrived mid-deploy)
  const serverRunningDeploy = !deploying
    ? app.deployments.find((d) => d.status === "running" || d.status === "queued")
    : null;

  // If a deploy is already running (e.g. auto-deploy on creation),
  // show the in-progress UI and poll for updates until it finishes
  useEffect(() => {
    if (!serverRunningDeploy || deploying) return;
    setDeploying(true);
    setDeployStartTime(new Date(serverRunningDeploy.startedAt).getTime());
    setActiveTab("deployments");
    setExpandedDeployLog(false);

    let stopped = false;
    async function poll() {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 3000));
        if (stopped) break;
        try {
          const res = await fetch(
            `/api/v1/organizations/${orgId}/apps/${app.id}`,
          );
          if (!res.ok) continue;
          const { app: updated } = await res.json();
          const dep = updated.deployments?.find((d: { id: string }) => d.id === serverRunningDeploy!.id);
          if (dep?.log) {
            setDeployLog(dep.log.split("\n"));
          }
          if (dep?.status === "success" || dep?.status === "failed") {
            if (dep.status === "success") {
              toast.success(`Deployed in ${dep.durationMs ? Math.round(dep.durationMs / 1000) + "s" : "—"}`);
            } else {
              toast.error("Deployment failed");
            }
            setViewingLogId(dep.id);
            stopped = true;
          }
        } catch { /* retry */ }
      }
      setDeploying(false);
      setDeployAbort(null);
      router.refresh();
    }

    poll();
    return () => { stopped = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunningDeploy?.id]);

  // Real-time updates via SSE (Redis pub/sub), with polling fallback
  useEffect(() => {
    const eventsUrl = `/api/v1/organizations/${orgId}/apps/${app.id}/events`;
    let es: EventSource | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;

    try {
      es = new EventSource(eventsUrl);

      es.addEventListener("deploy:complete", () => {
        // Deploy finished — refresh server data
        router.refresh();
      });

      es.onerror = () => {
        // SSE failed — fall back to polling
        es?.close();
        es = null;
        if (!fallbackInterval) {
          fallbackInterval = setInterval(() => router.refresh(), 10000);
        }
      };
    } catch {
      // EventSource not supported or failed — fall back to polling
      fallbackInterval = setInterval(() => router.refresh(), 10000);
    }

    return () => {
      es?.close();
      if (fallbackInterval) clearInterval(fallbackInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.id, orgId]);

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    window.history.replaceState({}, "", buildAppPath(app.name, app.environments, selectedEnvId, tab));
  }, [app.name, app.environments, selectedEnvId]);

  // Tag management state
  const [tagPopoverOpen, setTagPopoverOpen] = useState(false);
  const [togglingTagId, setTogglingTagId] = useState<string | null>(null);

  const appTagIds = new Set(
    (app.appTags ?? []).map((pt) => pt.tag.id)
  );

  async function handleToggleTag(tagId: string) {
    const isApplied = appTagIds.has(tagId);
    setTogglingTagId(tagId);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/tags`,
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

  const canDelete = isAdmin(userRole);

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
      if (app.source === "git") {
        body.gitBranch = gitBranch;
      }
      if (rootDirectory.trim()) {
        body.rootDirectory = rootDirectory.trim();
      } else {
        body.rootDirectory = null;
      }
      if (editImageName.trim()) body.imageName = editImageName.trim();
      body.restartPolicy = restartPolicy;
      if (editParentId) {
        body.projectId = editParentId;
      } else {
        body.projectId = null;
      }

      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}`,
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

      toast.success("App updated");
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
        `/api/v1/organizations/${orgId}/apps/${app.id}`,
        { method: "DELETE" }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete");
        return;
      }

      toast.success("App deleted");
      router.push("/projects");
    } catch {
      toast.error("Failed to delete");
    } finally {
      setDeleting(false);
    }
  }

  async function handleDeleteEnvironment() {
    if (!selectedEnvId || isProduction) return;
    setDeletingEnv(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/environments`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: selectedEnvId }),
        }
      );

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to delete environment");
        return;
      }

      toast.success(`Environment "${selectedEnv?.name}" deleted`);
      setSelectedEnvId(productionEnv?.id);
      setDeleteEnvOpen(false);
      router.refresh();
    } catch {
      toast.error("Failed to delete environment");
    } finally {
      setDeletingEnv(false);
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
        `/api/v1/organizations/${orgId}/apps/${app.id}/deploy`,
        {
          method: "POST",
          signal: abort.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: selectedEnvId }),
        }
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

  // (Auto-deploy is now triggered server-side on app creation)

  async function handleSetPrimaryDomain(domainId: string) {
    try {
      // Clear all primary flags, then set the selected one
      for (const d of app.domains) {
        if (d.id === domainId && !d.isPrimary) {
          // This is a simple approach — ideally a single API call
          await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/domains/primary`, {
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
        `/api/v1/organizations/${orgId}/apps/${app.id}/domains`,
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
        `/api/v1/organizations/${orgId}/apps/${app.id}/domains`,
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

  async function handleDomainUpdate(id: string) {
    if (!editDomainValue.trim()) return;
    setDomainSaving(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${app.id}/domains`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            domain: editDomainValue.trim(),
            port: editDomainPort ? parseInt(editDomainPort, 10) : null,
          }),
        }
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to update domain");
        return;
      }
      toast.success("Domain updated — redeploy to apply");
      setEditingDomainId(null);
      router.refresh();
    } catch {
      toast.error("Failed to update domain");
    } finally {
      setDomainSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageToolbar
        actions={
          <div className="flex items-center gap-2">
            {app.status === "active" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className={app.needsRedeploy
                    ? "bg-status-warning-muted text-status-warning hover:bg-status-warning/20"
                    : "bg-status-success-muted text-status-success hover:bg-status-success/20"
                  }>
                    {app.needsRedeploy ? (
                      <AlertTriangle className="mr-1.5 size-3.5" />
                    ) : (
                      <span className="mr-1.5 size-2 rounded-full bg-status-success animate-pulse" />
                    )}
                    {app.needsRedeploy ? "Restart Needed" : "Running"}
                    {!app.needsRedeploy && (() => {
                      const lastDeploy = app.deployments.find((d) => d.status === "success");
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
                      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/restart`, { method: "POST" });
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
                      const res = await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/stop`, { method: "POST" });
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
                  <><Rocket className="mr-1.5 size-4" />{app.status === "error" ? "Retry" : "Deploy"}</>
                )}
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <Pencil className="mr-1.5 size-4" />
              Edit
            </Button>
            {canDelete && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="icon-sm"
                    variant="outline"
                  >
                    <EllipsisVertical className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {/* Parent switcher */}
                  {!app.project && allParentApps.length > 0 && (
                    <>
                      <DropdownMenuItem
                        className="text-muted-foreground"
                        onClick={() => setEditOpen(true)}
                      >
                        <Plus className="mr-2 size-3.5" />
                        Assign parent
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                    </>
                  )}
                  {!isProduction && selectedEnv && (
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteEnvOpen(true)}
                    >
                      <X className="mr-2 size-4" />
                      Delete {selectedEnv.name} environment
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="mr-2 size-4" />
                    Delete app
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        }
      >
        {app.project ? (
          <>
            <Link
              href={`/projects/${app.project.name}`}
              className="text-2xl font-semibold tracking-tight text-muted-foreground hover:text-foreground transition-colors"
            >
              {app.project.displayName}
            </Link>
            <span className="text-muted-foreground/40 text-xl">›</span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <span className={`size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <ChevronDown className="size-3.5 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* Current app */}
                <DropdownMenuItem disabled>
                  <span className={`mr-2 size-2 rounded-full ${statusDotColor(app.status)}`} />
                  {app.displayName}
                  <Check className="ml-auto size-3.5" />
                </DropdownMenuItem>
                {/* Sibling apps */}
                {siblings.map((sibling) => (
                  <DropdownMenuItem key={sibling.name} asChild>
                    <Link href={`/apps/${sibling.name}`} className="flex items-center gap-2">
                      <span className={`mr-2 size-2 rounded-full ${statusDotColor(sibling.status)}`} />
                      {sibling.displayName}
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : (
          <h1 className="text-2xl font-semibold tracking-tight">
            {app.displayName}
          </h1>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={`gap-1.5 ${!isProduction ? (
                selectedEnv?.type === "staging"
                  ? "border-status-warning/40 bg-status-warning-muted text-status-warning"
                  : "border-status-info/40 bg-status-info-muted text-status-info"
              ) : ""}`}
            >
              <span className={`size-2 rounded-full ${envTypeDotColor(selectedEnv?.type ?? "production")}`} />
              {selectedEnv?.name ?? "production"}
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {app.environments.map((env) => (
              <DropdownMenuItem
                key={env.id}
                onClick={() => setSelectedEnvId(env.id)}
              >
                <span className={`mr-2 size-2 rounded-full ${envTypeDotColor(env.type)}`} />
                {env.name}
                {env.gitBranch && env.type !== "production" && (
                  <span className="ml-1 text-xs text-muted-foreground font-mono">{env.gitBranch}</span>
                )}
                {env.id === selectedEnvId && <Check className="ml-auto size-3.5" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-muted-foreground"
              onClick={() => {
                setNewEnvCloneFrom(
                  isProduction ? "__production" : (selectedEnvId ?? "__production")
                );
                setNewEnvOpen(true);
              }}
            >
              <Plus className="mr-2 size-3.5" />
              New environment
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageToolbar>

      {/* Error banner — only show if the current environment has a failed deploy */}
      {app.status === "error" && (() => {
        const failedDeploy = filteredDeployments.find((d) => d.status === "failed");
        if (!failedDeploy) return null;
        const errorLine = failedDeploy.log
          ?.split("\n")
          .reverse()
          .find((l) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed") || l.includes("crashed"));
        // Sanitize tokens/secrets from error messages
        const cleaned = errorLine
          ?.replace(/^\[.*?\]\s*/, "")
          .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
          .replace(/ghs_[A-Za-z0-9]+/g, "***")
          .trim();
        return (
          <div className="flex items-center gap-2 rounded-lg bg-status-error-muted px-4 py-2.5 text-sm text-status-error">
            <X className="size-4 shrink-0" />
            <span className="truncate">{cleaned || "App crashed — check the deploy log for details"}</span>
            {failedDeploy && (
              <button
                type="button"
                onClick={() => { setActiveTab("deployments"); setViewingLogId(failedDeploy.id); }}
                className="shrink-0 text-xs underline underline-offset-2 opacity-80 hover:opacity-100"
              >
                View log
              </button>
            )}
          </div>
        );
      })()}

      {/* Environment context banner */}
      {selectedEnv && !isProduction && (
        <div className={`flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm ${
          selectedEnv.type === "staging"
            ? "bg-status-warning-muted text-status-warning"
            : "bg-status-info-muted text-status-info"
        }`}>
          <span className={`size-2 rounded-full ${envTypeDotColor(selectedEnv.type)}`} />
          Viewing <span className="font-medium">{selectedEnv.name}</span> environment
          {filteredDeployments.length === 0 && (
            <span className="text-xs opacity-70 ml-1">— no deployments yet, deploy to get started</span>
          )}
        </div>
      )}

      {/* Overview */}
      <div className="flex gap-5">
        {/* Project icon */}
        {(() => {
          const { icon: iconUrl } = detectAppType({
            imageName: app.imageName,
            gitUrl: app.gitUrl,
            deployType: app.deployType,
            name: app.name,
            displayName: app.displayName,
          });
          return iconUrl ? (
            <img src={iconUrl} alt="" className="size-12 shrink-0 mt-0.5 opacity-60" />
          ) : (
            <div className="size-12 shrink-0 rounded-lg bg-muted/50 flex items-center justify-center mt-0.5">
              <Container className="size-6 text-muted-foreground/50" />
            </div>
          );
        })()}

        <div className="flex-1 min-w-0 space-y-3">
          {/* Description + domain */}
          {app.description && (
            <p className="text-sm text-muted-foreground">{app.description}</p>
          )}

          {app.domains.length > 0 && (
            <div className="flex items-center gap-2">
              {(() => {
                const primary = app.domains.find((d) => d.isPrimary) || app.domains[0];
                const rest = app.domains.length - 1;
                return (
                  <>
                    <a
                      href={`https://${primary.domain}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {primary.domain}
                    </a>
                    {rest > 0 && (
                      <button
                        type="button"
                        onClick={() => setActiveTab("networking")}
                        className="text-xs text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      >
                        +{rest}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {/* Source line */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {app.source === "git" && app.gitUrl && (
              <span className="font-mono">
                {app.gitUrl.replace("https://github.com/", "").replace(".git", "")}
                {app.gitBranch && app.gitBranch !== "main" && (
                  <span className="text-muted-foreground/50">:{app.gitBranch}</span>
                )}
              </span>
            )}
            {app.deployType === "image" && app.imageName && (
              <span className="font-mono">{app.imageName}</span>
            )}
            {app.containerPort && (
              <span>:{app.containerPort}</span>
            )}
            <span className="text-muted-foreground/40">
              {deployTypeLabel(app.deployType)}
            </span>
            <span className="text-muted-foreground/40">
              {new Date(app.createdAt).toLocaleDateString()}
            </span>
          </div>

          {/* Tags */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {(app.appTags ?? []).map(({ tag }) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ backgroundColor: `${tag.color}15`, color: tag.color }}
              >
                <span className="size-1.5 rounded-full" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </span>
            ))}
            {allTags.length > 0 && (
              <Popover open={tagPopoverOpen} onOpenChange={setTagPopoverOpen}>
                <PopoverTrigger asChild>
                  <button className="inline-flex items-center justify-center size-5 rounded-full border border-dashed border-muted-foreground/20 text-muted-foreground/40 hover:text-muted-foreground hover:border-muted-foreground/40 transition-colors">
                    <Plus className="size-2.5" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-48 p-1.5">
                  {allTags.map((tag) => {
                    const isApplied = appTagIds.has(tag.id);
                    const isToggling = togglingTagId === tag.id;
                    return (
                      <button
                        key={tag.id}
                        disabled={isToggling}
                        onClick={() => handleToggleTag(tag.id)}
                        className="flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-accent transition-colors disabled:opacity-50"
                      >
                        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="flex-1 text-left truncate">{tag.name}</span>
                        {isToggling ? <Loader2 className="size-3 animate-spin" /> : isApplied ? <Check className="size-3" /> : null}
                      </button>
                    );
                  })}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </div>

      {/* Tabbed sections */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList variant="line">
          <TabsTrigger value="deployments">
            Deployments
            {filteredDeployments.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {filteredDeployments.length}
              </Badge>
            )}
          </TabsTrigger>
          {app.connectionInfo && app.connectionInfo.length > 0 && (
            <TabsTrigger value="connect">
              Connect
            </TabsTrigger>
          )}
          <TabsTrigger value="variables">
            Variables
            {app.envVars.length > 0 && (
              <Badge variant="secondary" className="ml-1.5 text-xs">
                {app.envVars.length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="networking">
            Networking
          </TabsTrigger>
          <TabsTrigger value="logs">
            Logs
          </TabsTrigger>
          <TabsTrigger value="volumes">
            Volumes
          </TabsTrigger>
          <TabsTrigger value="cron">
            Cron
          </TabsTrigger>
          <TabsTrigger value="terminal">
            Terminal
          </TabsTrigger>
          <TabsTrigger value="metrics">
            Metrics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="deployments" className="pt-4 space-y-4">
          {filteredDeployments.length === 0 && !deploying && !serverRunningDeploy ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
              <p className="text-sm text-muted-foreground">
                No deployments yet.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* In-progress deployment (client-side SSE stream) */}
              {deploying && (
                <InProgressDeployCard
                  stages={deployStages}
                  log={deployLog}
                  startTime={deployStartTime}
                  expanded={expandedDeployLog}
                  onToggleExpand={() => setExpandedDeployLog(!expandedDeployLog)}
                  onAbort={() => deployAbort?.abort()}
                  canAbort
                />
              )}
              {/* In-progress deployment detected from server data (e.g. arrived mid-deploy) */}
              {!deploying && serverRunningDeploy && (
                <InProgressDeployCard
                  stages={{}}
                  log={[]}
                  startTime={new Date(serverRunningDeploy.startedAt).getTime()}
                  expanded={false}
                  onToggleExpand={() => {}}
                  trigger={serverRunningDeploy.trigger}
                />
              )}

              {filteredDeployments
                .filter((d) => d.status !== "queued" && d.status !== "running")
                .map((deployment, idx) => {
                const isActive = deployment.status === "success" && app.status === "active" && idx === 0;
                const isStopped = deployment.status === "success" && app.status === "stopped" && idx === 0;
                const isErrored = deployment.status === "success" && app.status === "error" && idx === 0;
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
                      ) : deployment.status === "success" && idx > 0 && app.status === "active" ? (
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
                          {deployment.gitSha && (() => {
                            const commitUrl = app.gitUrl?.replace(/\.git$/, "");
                            const sha7 = deployment.gitSha.slice(0, 7);
                            return commitUrl ? (
                              <a
                                href={`${commitUrl}/commit/${deployment.gitSha}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0 hover:bg-accent transition-colors"
                              >
                                {sha7}
                              </a>
                            ) : (
                              <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
                                {sha7}
                              </code>
                            );
                          })()}
                        </div>
                        <p className="text-xs text-foreground/60 mt-0.5">
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
                        {(deployment.status === "failed" || isErrored) && deployment.log && (() => {
                          // Extract the last ERROR line from the deploy log
                          const lines = deployment.log.split("\n");
                          const errorLine = [...lines].reverse().find(
                            (l) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed") || l.includes("crashed")
                          );
                          if (!errorLine) return null;
                          const cleaned = errorLine
                            .replace(/^\[.*?\]\s*/, "")
                            .replace(/x-access-token:[^\s@]+/g, "x-access-token:***")
                            .replace(/ghs_[A-Za-z0-9]+/g, "***")
                            .trim();
                          return (
                            <p className="text-xs text-status-error mt-1 truncate max-w-md" title={cleaned}>
                              {cleaned}
                            </p>
                          );
                        })()}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-foreground/50 shrink-0">
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
                    <DeploymentLog log={deployment.log} />
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

        {app.connectionInfo && app.connectionInfo.length > 0 && (
          <TabsContent value="connect" className="pt-4">
            <div className="space-y-6">
              {/* Internal connection */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Internal <span className="text-muted-foreground font-normal">(Docker network)</span></h3>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{showVarNames ? "Variables" : "Values"}</span>
                    <Switch
                      checked={showVarNames}
                      onCheckedChange={setShowVarNames}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {showVarNames
                    ? "Showing variable references — paste these into other apps."
                    : "Showing resolved values — toggle to see variable references."}
                </p>
                <div className="rounded-lg border bg-card divide-y">
                  {app.connectionInfo.map((info) => {
                    const resolved = info.value
                      .replace(/\$\{project\.name\}/g, app.name)
                      .replace(/\$\{project\.port\}/g, String(app.containerPort || ""))
                      .replace(/\$\{project\.id\}/g, app.id)
                      .replace(/\$\{([A-Z_]+)\}/g, (_match, key) => {
                        const envVar = app.envVars.find((v) => v.key === key);
                        return envVar?.value || `\${${key}}`;
                      });

                    // Build full reference: ${projectName.VAR_KEY}
                    const fullRef = info.copyRef
                      ? info.copyRef === "HOST"
                        ? `\${${app.name}}`
                        : `\${${app.name}.${info.copyRef}}`
                      : null;
                    const displayValue = showVarNames ? (fullRef || resolved) : resolved;
                    const copyValue = fullRef || resolved;

                    return (
                      <div key={info.label} className="flex items-center justify-between px-4 py-3 gap-4">
                        <span className="text-xs text-muted-foreground shrink-0 w-28">{info.label}</span>
                        <span className={`text-sm font-mono truncate flex-1 ${showVarNames ? "text-status-info" : ""}`}>
                          {displayValue}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(copyValue);
                            toast.success(`Copied ${copyValue}`);
                          }}
                          className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          title={`Copy: ${copyValue}`}
                        >
                          <Copy className="size-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* External connection */}
              {(app.exposedPorts as { internal: number; external?: number; description?: string }[] | null)?.some((p) => p.external) && (
                <div className="space-y-3">
                  <h3 className="text-sm font-medium">External <span className="text-muted-foreground font-normal">(host ports)</span></h3>
                  <p className="text-xs text-muted-foreground">
                    Use these to connect from outside Docker (e.g. database tools, local development).
                  </p>
                  <div className="rounded-lg border bg-card divide-y">
                    {(app.exposedPorts as { internal: number; external?: number; description?: string }[])
                      .filter((p) => p.external)
                      .map((p) => (
                        <div key={p.internal} className="flex items-center justify-between px-4 py-3 gap-4">
                          <span className="text-xs text-muted-foreground shrink-0 w-28">
                            {p.description || `Port ${p.internal}`}
                          </span>
                          <span className="text-sm font-mono flex-1">
                            localhost:{p.external}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(`localhost:${p.external}`);
                              toast.success("Copied");
                            }}
                            className="shrink-0 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                          >
                            <Copy className="size-3.5" />
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}
            </div>
          </TabsContent>
        )}

        <TabsContent value="variables" className="pt-4 space-y-4">
          <EnvEditor
            appId={app.id}
            appName={app.name}
            orgId={orgId}
            allAppNames={allAppNames}
            orgVarKeys={orgVarKeys}
          />
        </TabsContent>

        <TabsContent value="networking" className="space-y-8 pt-4">
          {/* Domains */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Domains</h3>
                <p className="text-xs text-muted-foreground mt-0.5">Route traffic to your app via custom domains.</p>
              </div>
              <Button
                size="sm"
                onClick={() => {
                  setNewDomain("");
                  setNewDomainPort("");
                  setDomainOpen(!domainOpen);
                }}
              >
                <Plus className="mr-1.5 size-4" />
                Add Domain
              </Button>
            </div>

            {domainOpen && (
              <div className="flex items-end gap-3 rounded-lg border bg-card p-4">
                <div className="grid gap-1.5 flex-1">
                  <label className="text-xs text-muted-foreground">Domain</label>
                  <input
                    placeholder="app.example.com"
                    value={newDomain}
                    onChange={(e) => setNewDomain(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                    className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                    autoFocus
                  />
                </div>
                <div className="grid gap-1.5">
                  <label className="text-xs text-muted-foreground">Port</label>
                  <input
                    type="number"
                    placeholder={String(app.containerPort || 3000)}
                    value={newDomainPort}
                    onChange={(e) => setNewDomainPort(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleDomainAdd(); }}
                    className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
                  />
                </div>
                <Button size="sm" onClick={handleDomainAdd} disabled={domainSaving || !newDomain.trim()}>
                  {domainSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Add"}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDomainOpen(false)}>
                  Cancel
                </Button>
              </div>
            )}

            {app.domains.length === 0 && !domainOpen ? (
              <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8">
                <p className="text-sm text-muted-foreground">
                  No domains configured.
                </p>
              </div>
            ) : app.domains.length > 0 && (
              <div className="space-y-2">
                {app.domains
                  .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))
                  .map((domain) => {
                    const isAutoGenerated = domain.domain.endsWith(".localhost");
                    const autoDomain = app.domains.find((d) => d.domain.endsWith(".localhost"))?.domain;
                    const isEditing = editingDomainId === domain.id;

                    if (isEditing) {
                      return (
                        <div key={domain.id} className="flex items-end gap-3 rounded-lg border bg-card p-4">
                          <div className="grid gap-1.5 flex-1">
                            <label className="text-xs text-muted-foreground">Domain</label>
                            <input
                              value={editDomainValue}
                              onChange={(e) => setEditDomainValue(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                              className="h-9 rounded-md border bg-background px-3 text-sm font-mono"
                              autoFocus
                            />
                          </div>
                          <div className="grid gap-1.5">
                            <label className="text-xs text-muted-foreground">Port</label>
                            <input
                              type="number"
                              placeholder={String(app.containerPort || 3000)}
                              value={editDomainPort}
                              onChange={(e) => setEditDomainPort(e.target.value)}
                              onKeyDown={(e) => { if (e.key === "Enter") handleDomainUpdate(domain.id); if (e.key === "Escape") setEditingDomainId(null); }}
                              className="h-9 w-24 rounded-md border bg-background px-3 text-sm font-mono"
                            />
                          </div>
                          <Button size="sm" onClick={() => handleDomainUpdate(domain.id)} disabled={domainSaving || !editDomainValue.trim()}>
                            {domainSaving ? <Loader2 className="size-3.5 animate-spin" /> : "Save"}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingDomainId(null)}>
                            Cancel
                          </Button>
                        </div>
                      );
                    }

                    return (
                  <div
                    key={domain.id}
                    className={`squircle rounded-lg border bg-card overflow-hidden ${domain.isPrimary ? "border-primary/30" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-4 p-4">
                      <div className="flex items-center gap-3 min-w-0">
                        {(() => {
                          const status = domainStatuses[domain.id];
                          return (
                            <button
                              type="button"
                              onClick={() => openDomainSheet(domain.id)}
                              className="flex items-center gap-1.5 shrink-0 hover:opacity-70 transition-opacity"
                            >
                              <span
                                className={`size-2 rounded-full ${
                                  status === "resolving" ? "bg-status-success" :
                                  status === "not-configured" ? "bg-status-warning" :
                                  status === "checking" ? "bg-status-neutral animate-pulse" :
                                  "bg-status-neutral"
                                }`}
                              />
                              <span className={`text-xs ${
                                status === "resolving" ? "text-status-success" :
                                status === "not-configured" ? "text-status-warning" :
                                "text-muted-foreground"
                              }`}>
                                {status === "resolving" ? "Connected" :
                                 status === "not-configured" ? "Not connected" :
                                 "Checking"}
                              </span>
                            </button>
                          );
                        })()}
                        <a
                          href={`${domain.domain.includes("localhost") ? "http" : "https"}://${domain.domain}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-medium font-mono truncate hover:underline"
                        >
                          {domain.domain}
                        </a>
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
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Edit domain"
                          onClick={() => {
                            setEditingDomainId(domain.id);
                            setEditDomainValue(domain.domain);
                            setEditDomainPort(domain.port?.toString() || "");
                          }}
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        {!isAutoGenerated && (
                          <Button
                            size="sm"
                            variant="ghost"
                            title="DNS settings"
                            onClick={() => openDomainSheet(domain.id)}
                          >
                            <Info className="size-3.5" />
                          </Button>
                        )}
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
                  </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Exposed Ports */}
          <PortsManager
            ports={app.exposedPorts || []}
            appId={app.id}
            orgId={orgId}
          />
        </TabsContent>

        <TabsContent value="logs" className="pt-4">
          <LogViewer
            key={`logs-${selectedEnvId}`}
            streamUrl={`/api/v1/organizations/${orgId}/apps/${app.id}/logs/stream${selectedEnv ? `?environment=${selectedEnv.name}` : ""}`}
          />
        </TabsContent>

        <TabsContent value="volumes" className="pt-4">
          <VolumesPanel appId={app.id} orgId={orgId} />
        </TabsContent>

        <TabsContent value="cron" className="pt-4">
          <CronManager appId={app.id} orgId={orgId} />
        </TabsContent>

        <TabsContent value="terminal" className="pt-4">
          <AppTerminal key={`terminal-${selectedEnvId}`} appId={app.id} orgId={orgId} />
        </TabsContent>

        <TabsContent value="metrics" className="pt-4">
          <AppMetrics key={`metrics-${selectedEnvId}`} orgId={orgId} appId={app.id} environmentName={selectedEnv?.name} />
        </TabsContent>

      </Tabs>

      {/* New Environment Bottom Sheet */}
      <BottomSheet open={newEnvOpen} onOpenChange={setNewEnvOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>New environment</BottomSheetTitle>
            <BottomSheetDescription>
              Create a new environment from a branch. Variables are cloned from the source environment.
            </BottomSheetDescription>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            <div className="grid gap-5 py-4">
              {/* Branch + Name */}
              <div className="grid gap-4 sm:grid-cols-2">
                {app.source === "git" ? (
                  <div className="grid gap-2">
                    <Label>Branch</Label>
                    <BranchSelect
                      value={newEnvBranch}
                      onChange={(v) => {
                        const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
                        setNewEnvBranch(v);
                        if (!newEnvName || newEnvName === slugify(newEnvBranch)) {
                          setNewEnvName(slugify(v));
                        }
                      }}
                      appId={app.id}
                      orgId={orgId}
                      excludeBranch={app.gitBranch || "main"}
                    />
                  </div>
                ) : (
                  <div className="grid gap-2">
                    <Label>Name</Label>
                    <Input
                      placeholder="e.g. staging, qa, demo"
                      value={newEnvName}
                      onChange={(e) => setNewEnvName(e.target.value)}
                    />
                  </div>
                )}
                <div className="grid gap-2">
                  <Label>Environment name</Label>
                  <Input
                    placeholder={app.source === "git" ? "Auto-generated from branch" : "e.g. staging, qa"}
                    value={newEnvName}
                    onChange={(e) => setNewEnvName(e.target.value)}
                  />
                </div>
              </div>

              {/* Clone source */}
              <div className="grid gap-2 sm:w-1/2">
                <Label>Clone variables from</Label>
                <Select value={newEnvCloneFrom} onValueChange={setNewEnvCloneFrom}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__production">Production</SelectItem>
                    {app.environments
                      .filter((e) => e.type !== "production")
                      .map((e) => (
                        <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>
                      ))}
                    <SelectItem value="__none">Empty (no variables)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <BottomSheetFooter>
            <Button
              variant="outline"
              onClick={() => { setNewEnvOpen(false); setNewEnvName(""); setNewEnvBranch(""); setNewEnvCloneFrom("__production"); }}
              disabled={newEnvSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreateEnv}
              disabled={!newEnvName.trim() || newEnvSaving || (app.source === "git" && !newEnvBranch.trim())}
            >
              {newEnvSaving ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Creating...</>
              ) : (
                "Create & Deploy"
              )}
            </Button>
          </BottomSheetFooter>
        </BottomSheetContent>
      </BottomSheet>

      {/* Edit Bottom Sheet */}
      <BottomSheet open={editOpen} onOpenChange={setEditOpen}>
        <BottomSheetContent>
          <BottomSheetHeader>
            <BottomSheetTitle>Edit app</BottomSheetTitle>
            <BottomSheetDescription>
              Update app configuration.
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

              {/* Image */}
              {app.deployType === "image" && (
                <div className="grid gap-2">
                  <Label htmlFor="edit-image">Image</Label>
                  <Input
                    id="edit-image"
                    placeholder="postgres:16"
                    value={editImageName}
                    onChange={(e) => setEditImageName(e.target.value)}
                    className="font-mono"
                  />
                </div>
              )}

              {/* Source settings */}
              {app.source === "git" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>Branch</Label>
                    <BranchSelect
                      value={gitBranch}
                      onChange={setGitBranch}
                      appId={app.id}
                      orgId={orgId}
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

              {/* Restart policy */}
              <div className="grid gap-2 sm:w-1/2">
                <Label>Restart Policy</Label>
                <Select value={restartPolicy} onValueChange={setRestartPolicy}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unless-stopped">Unless Stopped</SelectItem>
                    <SelectItem value="always">Always</SelectItem>
                    <SelectItem value="on-failure">On Failure</SelectItem>
                    <SelectItem value="no">Never</SelectItem>
                  </SelectContent>
                </Select>
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

              {/* Project */}
              <div className="grid gap-2">
                <Label>Project</Label>
                <Select
                  value={editParentId ?? ""}
                  onValueChange={setEditParentId}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {allParentApps.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: p.color }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Group this app under a project for organization.
                </p>
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

      {/* Domain Status Sheet */}
      {(() => {
        const dnsDomain = app.domains.find((d) => d.id === dnsDomainId);
        const autoDomain = app.domains.find((d) => d.domain.endsWith(".localhost"))?.domain;
        if (!dnsDomain) return null;
        const status = domainStatuses[dnsDomain.id];
        const isLocal = dnsDomain.domain.endsWith(".localhost");
        return (
          <BottomSheet open={!!dnsDomainId} onOpenChange={(v) => {
            if (!v) {
              setDnsDomainId(null);
              window.history.replaceState({}, "", `/apps/${app.name}/networking`);
            }
          }}>
            <BottomSheetContent>
              <BottomSheetHeader>
                <BottomSheetTitle>{isLocal ? "Domain Status" : "DNS Configuration"}</BottomSheetTitle>
                <BottomSheetDescription>
                  <span className="font-mono">{dnsDomain.domain}</span>
                </BottomSheetDescription>
              </BottomSheetHeader>
              <div className="flex-1 overflow-y-auto px-6 pb-6 space-y-6">
                {/* Status */}
                <div className="flex items-center gap-3">
                    <span className={`size-2.5 rounded-full ${
                      status === "resolving" ? "bg-status-success" :
                      status === "not-configured" ? "bg-status-warning" :
                      "bg-status-neutral animate-pulse"
                    }`} />
                    <span className="text-sm">
                      {isLocal
                        ? (status === "resolving" ? "Service is reachable" : status === "not-configured" ? "Service is not reachable" : "Checking...")
                        : (status === "resolving" ? "Domain is correctly pointed to this server" : status === "not-configured" ? "Domain is not pointed to this server" : "Checking domain status...")}
                    </span>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setDomainCheckTick((t) => t + 1)}
                    disabled={status === "checking"}
                  >
                    {status === "checking" ? (
                      <><Loader2 className="mr-1 size-3 animate-spin" />Checking</>
                    ) : (
                      "Check again"
                    )}
                  </Button>
                </div>

                {isLocal ? (
                  /* Local domain info */
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">
                      This is an auto-generated local domain routed by Traefik. It resolves automatically on this machine — no DNS configuration needed.
                    </p>
                    {status === "not-configured" && (
                      <p className="text-sm text-status-warning">
                        The service isn't responding. Make sure the app is running and the container is healthy.
                      </p>
                    )}
                  </div>
                ) : (
                  /* External domain DNS config */
                  <>
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium">Required DNS Record</h3>
                      <p className="text-xs text-muted-foreground">Use one of the following options:</p>
                      <div className="rounded-lg border bg-muted/30 divide-y">
                        <div className="grid grid-cols-3 gap-4 px-4 py-2 text-xs text-muted-foreground">
                          <span>Type</span>
                          <span>Name</span>
                          <span>Value</span>
                        </div>
                        {/* Option 1: A Record */}
                        <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm font-mono">
                          <span>A</span>
                          <span>{dnsDomain.domain}</span>
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="truncate text-muted-foreground">{serverIP || "your server IP"}</span>
                            <button
                              onClick={() => {
                                navigator.clipboard.writeText(serverIP || "");
                                toast.success("Copied");
                              }}
                              className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="size-3" />
                            </button>
                          </div>
                        </div>
                        {/* Option 2: CNAME (if there's a non-localhost base domain to point to) */}
                        {autoDomain && !autoDomain.endsWith(".localhost") && (
                          <div className="grid grid-cols-3 gap-4 px-4 py-3 text-sm font-mono">
                            <span>CNAME</span>
                            <span>{dnsDomain.domain}</span>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate">{autoDomain}</span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(autoDomain);
                                  toast.success("Copied");
                                }}
                                className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground"
                              >
                                <Copy className="size-3" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">Setup Instructions</h3>
                      <ol className="text-sm text-muted-foreground space-y-1.5 list-decimal list-inside">
                        <li>Go to your domain registrar or DNS provider</li>
                        <li>Add an <span className="font-mono text-foreground">A</span> record pointing to {serverIP || "your server IP"}{autoDomain && !autoDomain.endsWith(".localhost") && <>, or a <span className="font-mono text-foreground">CNAME</span> pointing to <span className="font-mono text-foreground">{autoDomain}</span></>}</li>
                        <li>Wait for DNS propagation (can take up to 48 hours)</li>
                        <li>SSL will be automatically provisioned once the domain resolves</li>
                      </ol>
                    </div>
                  </>
                )}
              </div>
              <BottomSheetFooter>
                <Button variant="outline" onClick={() => setDnsDomainId(null)}>
                  Close
                </Button>
              </BottomSheetFooter>
            </BottomSheetContent>
          </BottomSheet>
        );
      })()}

      {/* Delete Project Confirmation */}
      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete app"
        description={`Are you sure you want to delete "${app.displayName}"? This will remove all environments, deployments, domains, and environment variables. This action cannot be undone.`}
        onConfirm={handleDelete}
        loading={deleting}
      />

      {/* Delete Environment Confirmation */}
      <ConfirmDeleteDialog
        open={deleteEnvOpen}
        onOpenChange={setDeleteEnvOpen}
        title={`Delete ${selectedEnv?.name} environment`}
        description={`Are you sure you want to delete the "${selectedEnv?.name}" environment? This will remove its environment variables and deployments. The app itself will not be affected.`}
        onConfirm={handleDeleteEnvironment}
        loading={deletingEnv}
      />
    </div>
  );
}

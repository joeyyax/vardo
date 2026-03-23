"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import {
  ArrowLeft,
  Loader2,
  Github,
  Lock,
  Globe,
  GitBranch,
  Container,
  FileText,
  Globe2,
  RefreshCw,
} from "lucide-react";
import { notify } from "@/lib/notify";
import { PageToolbar } from "@/components/page-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { generateWordPair, getBaseDomain } from "@/lib/domains/auto-domain";
import { isReservedSlug } from "@/lib/domains/reserved";
import { EnvEditor } from "@/components/env-editor";
import { BranchSelect } from "@/components/branch-select";

type Source = "git" | "direct";
type DeployType = "compose" | "dockerfile" | "image" | "static";
type GitMode = "github" | "manual";

type Template = {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  category: string;
  source: string;
  deployType: string;
  imageName: string | null;
  gitUrl: string | null;
  gitBranch: string | null;
  defaultPort: number | null;
  defaultEnvVars:
    | { key: string; description: string; required: boolean; defaultValue?: string }[]
    | null;
  defaultVolumes:
    | { name: string; mountPath: string; description: string }[]
    | null;
  defaultConnectionInfo:
    | { label: string; value: string; copyRef?: string }[]
    | null;
  defaultCpuLimit: number | null;
  defaultMemoryLimit: number | null;
  defaultDiskWriteAlertThreshold: number | null;
};

type Installation = {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
};

type Repo = {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
};

type ParentAppOption = {
  id: string;
  name: string;
  color: string;
};

type Props = {
  orgId: string;
  orgSlug: string;
  templates: Template[];
  parentApps?: ParentAppOption[];
  defaultParentId?: string;
  defaultProjectId?: string;
  defaultName?: string;
  defaultImage?: string;
  defaultTemplate?: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  database: "Databases",
  cache: "Cache & Queues",
  monitoring: "Monitoring",
  web: "Web Servers",
  tool: "Tools",
  custom: "Custom",
};

const SOURCE_OPTIONS = [
  { id: "github", icon: Github, label: "GitHub", description: "From your connected account" },
  { id: "compose", icon: FileText, label: "Docker Compose", description: "Paste or from a repo" },
  { id: "image", icon: Container, label: "Image", description: "Any Docker image" },
] as const;

type SourceOption = (typeof SOURCE_OPTIONS)[number]["id"];

function generatePassword(length = 24): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

import { isSecretKey } from "@/lib/env/is-secret-key";
import { slugify } from "@/lib/ui/slugify";

export function NewAppFlow({ orgId, orgSlug, templates, parentApps = [], defaultParentId, defaultProjectId, defaultName, defaultImage, defaultTemplate }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);

  // What was selected
  const [selectedSource, setSelectedSource] = useState<SourceOption | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  // Form fields
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
  const [slugTaken, setSlugTaken] = useState(false);
  const [description, setDescription] = useState("");
  const [source, setSource] = useState<Source>("git");
  const [deployType, setDeployType] = useState<DeployType>("compose");
  const [gitMode, setGitMode] = useState<GitMode>("github");
  const [gitUrl, setGitUrl] = useState("");
  const [gitBranch, setGitBranch] = useState("main");
  const [imageName, setImageName] = useState("");
  const [composeContent, setComposeContent] = useState("");
  const [contentMode, setContentMode] = useState<"paste" | "url">("paste");
  const [rootDirectory, setRootDirectory] = useState("");
  const [containerPort, setContainerPort] = useState("");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [parentId, setParentId] = useState<string | null>(defaultProjectId ?? defaultParentId ?? null);
  const [persistData, setPersistData] = useState(true);
  const [templateVolumes, setTemplateVolumes] = useState<
    { name: string; mountPath: string; description: string }[]
  >([]);
  const [templateConnectionInfo, setTemplateConnectionInfo] = useState<
    { label: string; value: string; copyRef?: string }[]
  >([]);
  const [exposePort, setExposePort] = useState(false);
  const [createRepo, setCreateRepo] = useState(false);
  const [cpuLimit, setCpuLimit] = useState("");
  const [memoryLimit, setMemoryLimit] = useState("");
  const [diskWriteAlertThreshold, setDiskWriteAlertThreshold] = useState("");

  // Domain
  const [generateDomain, setGenerateDomain] = useState(true);
  const [wordPair, setWordPair] = useState(() => generateWordPair());
  const baseDomain = getBaseDomain();

  // Environment variables as raw .env content
  const [envContent, setEnvContent] = useState("");

  // GitHub state
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branches, setBranches] = useState<string[]>([]);

  const fetchInstallations = useCallback(async () => {
    setInstallationsLoading(true);
    try {
      const res = await fetch("/api/v1/github/installations");
      if (res.ok) {
        const data = await res.json();
        const list = data.installations || [];
        setInstallations(list);
        if (list.length === 1) setSelectedInstallation(list[0].id);
      }
    } catch { /* noop */ } finally {
      setInstallationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedInstallation) { setRepos([]); setSelectedRepo(""); return; }
    let cancelled = false;
    async function fetchRepos() {
      setReposLoading(true); setRepos([]); setSelectedRepo("");
      try {
        const res = await fetch(`/api/v1/github/repos?installationId=${selectedInstallation}`);
        if (res.ok && !cancelled) setRepos((await res.json()).repos || []);
      } catch { if (!cancelled) notify.toast.error("Failed to fetch repositories"); }
      finally { if (!cancelled) setReposLoading(false); }
    }
    fetchRepos();
    return () => { cancelled = true; };
  }, [selectedInstallation]);

  // Auto-fetch installations when GitHub source is selected
  useEffect(() => {
    fetchInstallations();
  }, [selectedSource, gitMode, fetchInstallations]);

  // Fetch branches when a repo is selected
  useEffect(() => {
    if (!selectedRepo || !selectedInstallation) { setBranches([]); return; }
    let cancelled = false;
    async function fetchBranches() {
      try {
        const res = await fetch(`/api/v1/github/branches?installationId=${selectedInstallation}&repo=${selectedRepo}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setBranches(data.branches || []);
        }
      } catch { /* noop */ }
    }
    fetchBranches();
    return () => { cancelled = true; };
  }, [selectedRepo, selectedInstallation]);

  // Apply query string defaults on mount
  useEffect(() => {
    if (defaultTemplate) {
      const match = templates.find(
        (t) => t.name === defaultTemplate || t.displayName === defaultTemplate
      );
      if (match) {
        selectTemplate(match);
        return;
      }
    }
    if (defaultImage) {
      selectSource("image");
      setImageName(defaultImage);
    }
    if (defaultName) {
      setDisplayName(defaultName);
      const base = slugify(defaultName);
      setName(base ? `${base}-${wordPair.adjective}-${wordPair.noun}` : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRepoSelect(repoFullName: string) {
    setSelectedRepo(repoFullName);
    const repo = repos.find((r) => r.fullName === repoFullName);
    if (!repo) return;
    setGitUrl(`https://github.com/${repo.fullName}.git`);
    setGitBranch(repo.defaultBranch);
    if (!displayName) {
      setDisplayName(repo.name);
      if (!slugEdited) setName(slugify(repo.name));
    }
  }

  function selectTemplate(template: Template) {
    setSelectedTemplate(template);
    setSelectedSource(null);
    setDisplayName(template.displayName);
    const wp = generateWordPair();
    setWordPair(wp);
    setName(`${slugify(template.name)}-${wp.adjective}-${wp.noun}`);
    setSlugEdited(false);
    setSource(template.source as Source);
    setDeployType(template.deployType as DeployType);
    if (template.imageName) setImageName(template.imageName);
    if (template.gitUrl) setGitUrl(template.gitUrl);
    if (template.gitBranch) setGitBranch(template.gitBranch);
    if (template.defaultPort) setContainerPort(template.defaultPort.toString());
    setDescription(template.description || "");
    // Databases/caches don't need public URLs but always need persistence
    const noUrlCategories = ["database", "cache"];
    const alwaysPersist = ["database", "cache", "monitoring", "tool"];
    setGenerateDomain(!noUrlCategories.includes(template.category));
    setPersistData(alwaysPersist.includes(template.category));
    setTemplateVolumes(template.defaultVolumes || []);
    setTemplateConnectionInfo(template.defaultConnectionInfo || []);
    setCpuLimit(template.defaultCpuLimit?.toString() || "");
    setMemoryLimit(template.defaultMemoryLimit?.toString() || "");
    setDiskWriteAlertThreshold(template.defaultDiskWriteAlertThreshold ? (template.defaultDiskWriteAlertThreshold / 1_073_741_824).toString() : "");
    if (template.defaultEnvVars?.length) {
      const slug = slugify(template.name);
      const lines: string[] = [`# ${template.displayName} configuration`];

      for (const ev of template.defaultEnvVars) {
        let value = ev.defaultValue || "";

        if (!value) {
          // Smart auto-fill
          if (isSecretKey(ev.key)) {
            value = generatePassword();
          } else {
            const lower = ev.key.toLowerCase();
            if (lower === "url" || lower === "base_url" || lower === "app_url" ||
                lower === "site_url" || lower === "public_url" || lower === "nextauth_url" ||
                lower.endsWith("_base_url") || lower.endsWith("_site_url")) {
              value = "${project.url}";
            } else if (lower === "hostname" || lower === "host" || lower === "domain" ||
                       lower === "virtual_host" || lower === "server_name") {
              value = "${project.domain}";
            } else if (lower === "port" || lower === "app_port" || lower === "server_port") {
              value = "${project.port}";
            } else if (lower === "node_env") {
              value = "production";
            } else if (lower.includes("_database") || lower.includes("_db")) {
              value = slug;
            } else if (lower.includes("_user") && !lower.includes("password")) {
              value = slug;
            }
          }
        }

        // Add description as comment
        if (ev.description) {
          lines.push(`# ${ev.description}`);
        }
        lines.push(`${ev.key}=${value}`);
      }

      lines.push("", "# Add your own variables below");
      setEnvContent(lines.join("\n"));
    } else {
      setEnvContent("");
    }
  }

  function selectSource(opt: SourceOption) {
    setSelectedSource(opt);
    setSelectedTemplate(null);
    setEnvContent("");
    setGenerateDomain(true);
    switch (opt) {
      case "github":
        setSource("git"); setDeployType("compose"); setGitMode("github");
        break;
      case "compose":
        setSource("direct"); setDeployType("compose"); setContentMode("paste");
        break;
      case "image":
        setSource("direct"); setDeployType("image");
        break;
    }
  }

  function goBack() {
    setSelectedSource(null);
    setSelectedTemplate(null);
    setEnvContent("");
    setGenerateDomain(true);
    setDisplayName(""); setName(""); setDescription("");
    setSlugEdited(false);
  }

  const appSlug = name || "my-app";
  const domainPreview = slugEdited
    ? `${appSlug}.${baseDomain}`
    : `${appSlug}-${wordPair.adjective}-${wordPair.noun}.${baseDomain}`;


  const isConfiguring = selectedSource !== null || selectedTemplate !== null;
  const hasRequiredEnvVars = false; // Env vars are now free-form in the textarea

  async function handleSubmit() {
    if (!displayName.trim() || !name.trim()) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        displayName: displayName.trim(), name: name.trim(),
        description: description.trim() || undefined,
        source, deployType, autoTraefikLabels: true, autoDeploy, generateDomain,
        projectId: parentId || undefined,
        persistentVolumes: persistData && templateVolumes.length > 0
          ? templateVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath }))
          : undefined,
        connectionInfo: templateConnectionInfo.length > 0 ? templateConnectionInfo : undefined,
        exposedPorts: exposePort && containerPort
          ? [{ internal: parseInt(containerPort, 10), description: "Primary port" }]
          : undefined,
      };
      if (containerPort) body.containerPort = parseInt(containerPort, 10);
      if (cpuLimit) body.cpuLimit = parseFloat(cpuLimit);
      if (memoryLimit) body.memoryLimit = parseInt(memoryLimit, 10);
      if (diskWriteAlertThreshold) body.diskWriteAlertThreshold = Math.round(parseFloat(diskWriteAlertThreshold) * 1_073_741_824);
      if (rootDirectory.trim()) body.rootDirectory = rootDirectory.trim();

      // Create GitHub repo if opted in
      if (createRepo && installations.length > 0) {
        const instId = selectedInstallation || installations[0].id;
        const repoRes = await fetch("/api/v1/github/repos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            installationId: instId,
            name: name.trim(),
            description: description.trim() || undefined,
            isPrivate: true,
          }),
        });
        if (repoRes.ok) {
          const { repo } = await repoRes.json();
          body.source = "git";
          body.deployType = "nixpacks";
          body.gitUrl = repo.cloneUrl;
          body.gitBranch = repo.defaultBranch;
          notify.toast.success(`Repository created: ${repo.fullName}`);
        } else {
          const err = await repoRes.json();
          notify.toast.error(err.error || "Failed to create repository");
          setCreating(false);
          return;
        }
      } else if (source === "git") {
        body.gitUrl = gitUrl;
        body.gitBranch = gitBranch;
      }

      if (deployType === "image") body.imageName = imageName;
      if (source === "direct" && deployType === "compose") {
        body.composeContent = composeContent || undefined;
      }

      const res = await fetch(`/api/v1/organizations/${orgId}/apps`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        notify.toast.error(data.error || "Failed to create app");
        return;
      }

      const { app } = await res.json();

      // Bulk-create env vars from .env content
      if (envContent.trim()) {
        await fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/env-vars`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: envContent }),
        });
      }

      // Trigger deploy via API so the app detail page can pick up the SSE stream
      if (autoDeploy) {
        fetch(`/api/v1/organizations/${orgId}/apps/${app.id}/deploy`, {
          method: "POST",
        }).catch(() => {
          // Deploy started server-side — client will see it on the detail page
        });
        notify.toast.success("App created — deploying...");
      } else {
        notify.toast.success("App created");
      }
      // Redirect to the project page if the app belongs to a project
      if (parentId) {
        const project = parentApps.find((p) => p.id === parentId);
        if (project) {
          router.push(`/projects/${project.name}`);
        } else {
          router.push(`/apps/${app.name}`);
        }
      } else {
        router.push(`/apps/${app.name}`);
      }
    } catch (err) { notify.toast.error(err instanceof Error ? err.message : "Failed to create app"); }
    finally { setCreating(false); }
  }

  // Group templates by category
  const templatesByCategory = templates.reduce<Record<string, Template[]>>((acc, t) => {
    const cat = t.category || "custom";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(t);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <PageToolbar>
        <h1 className="text-2xl font-semibold tracking-tight">New App</h1>
      </PageToolbar>

      {!isConfiguring ? (
        /* ─── Step 1: Pick source or template ─── */
        <div className="space-y-8 max-w-4xl">
          {/* Source options row */}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-3">
              Start from
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {SOURCE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => selectSource(opt.id)}
                    className="squircle flex flex-col items-center gap-2 rounded-lg border bg-card p-4 text-center transition-colors hover:bg-accent/50"
                  >
                    <Icon className="size-6 text-muted-foreground" />
                    <span className="text-sm font-medium">{opt.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {opt.description}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Templates */}
          {Object.entries(templatesByCategory).map(([category, tmpls]) => (
            <div key={category}>
              <h2 className="text-sm font-medium text-muted-foreground mb-3">
                {CATEGORY_LABELS[category] || category}
              </h2>
              <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {tmpls.map((tmpl) => (
                  <button
                    key={tmpl.id}
                    type="button"
                    onClick={() => selectTemplate(tmpl)}
                    className="squircle flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent/50"
                  >
                    {tmpl.icon ? (
                      <img
                        src={tmpl.icon}
                        alt=""
                        className="size-8 shrink-0"
                        style={{ filter: "drop-shadow(0 0 1px rgba(255,255,255,0.3))" }}
                      />
                    ) : (
                      <Container className="size-8 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {tmpl.displayName}
                      </p>
                      {tmpl.description && (
                        <p className="text-xs text-muted-foreground truncate">
                          {tmpl.description}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ─── Step 2: Configure ─── */
        <div className="max-w-2xl space-y-6">
          {/* Back + title */}
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={goBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h2 className="text-lg font-semibold">
                {selectedTemplate
                  ? selectedTemplate.displayName
                  : SOURCE_OPTIONS.find((s) => s.id === selectedSource)?.label || "New App"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {selectedTemplate?.description || "Configure your app."}
              </p>
            </div>
          </div>

          <div className="grid gap-5">
            {/* GitHub: repo picker comes FIRST */}
            {selectedSource === "github" && (
              <>
                {installationsLoading ? (
                  <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : installations.length === 0 ? (
                  <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-8 text-center">
                    <Github className="size-8 text-muted-foreground" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Connect GitHub to continue</p>
                      <p className="text-xs text-muted-foreground">
                        Install the GitHub App to import repositories and enable auto-deploy.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={connectingGithub}
                      onClick={async () => {
                        setConnectingGithub(true);
                        try {
                          const res = await fetch("/api/v1/github/connect");
                          if (res.ok) {
                            const data = await res.json();
                            if (data.url) {
                              window.location.href = data.url;
                              return;
                            }
                          }
                          notify.toast.error("Failed to start GitHub connection");
                        } catch {
                          notify.toast.error("Failed to connect GitHub");
                        } finally {
                          setConnectingGithub(false);
                        }
                      }}
                    >
                      {connectingGithub ? (
                        <Loader2 className="mr-1.5 size-4 animate-spin" />
                      ) : (
                        <Github className="mr-1.5 size-4" />
                      )}
                      Connect GitHub
                    </Button>
                  </div>
                ) : (
                  <>
                    {installations.length > 1 && (
                      <div className="grid gap-2">
                        <Label>Account</Label>
                        <Select value={selectedInstallation} onValueChange={setSelectedInstallation}>
                          <SelectTrigger><SelectValue placeholder="Select account" /></SelectTrigger>
                          <SelectContent>
                            {installations.map((inst) => (
                              <SelectItem key={inst.id} value={inst.id}>{inst.accountLogin}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {selectedInstallation && (
                      <div className="grid gap-2">
                        <Label>Repository</Label>
                        {reposLoading ? (
                          <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                            <span className="text-sm text-muted-foreground">Loading...</span>
                          </div>
                        ) : (
                          <Select value={selectedRepo} onValueChange={handleRepoSelect}>
                            <SelectTrigger><SelectValue placeholder="Select a repository" /></SelectTrigger>
                            <SelectContent>
                              {repos.map((repo) => (
                                <SelectItem key={repo.id} value={repo.fullName}>
                                  <span className="flex items-center gap-2">
                                    {repo.private ? <Lock className="size-3 text-muted-foreground" /> : <Globe className="size-3 text-muted-foreground" />}
                                    {repo.fullName}
                                  </span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* Only show the rest of the form once we have context (repo selected, or non-github source) */}
            {(selectedSource !== "github" || selectedRepo) && (
              <>
            {/* Name row */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="display-name">Name</Label>
                <Input
                  id="display-name"
                  placeholder="My App"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    if (!slugEdited) {
                      const base = slugify(e.target.value);
                      setName(base ? `${base}-${wordPair.adjective}-${wordPair.noun}` : "");
                    }
                  }}
                  autoFocus={selectedSource !== "github"}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="slug">Slug</Label>
                <Input
                  id="slug"
                  placeholder="my-app"
                  value={name}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                    setSlugTaken(false);
                  }}
                  onBlur={async () => {
                    if (!name.trim()) return;
                    try {
                      const res = await fetch(`/api/v1/organizations/${orgId}/apps`);
                      if (res.ok) {
                        const data = await res.json();
                        const exists = (data.apps || []).some((p: { name: string }) => p.name === name);
                        setSlugTaken(exists);
                      }
                    } catch {}
                  }}
                  className={slugTaken || (generateDomain && isReservedSlug(name)) ? "border-destructive" : ""}
                />
                {slugTaken && (
                  <p className="text-xs text-destructive">This slug is already in use</p>
                )}
                {!slugTaken && generateDomain && name && isReservedSlug(name) && (
                  <p className="text-xs text-destructive">"{name}" is reserved</p>
                )}
              </div>
            </div>

            {/* Public URL toggle + domain preview */}
            <div className="rounded-lg border border-dashed bg-muted/50 px-4 py-3 space-y-2">
              <div className="flex items-center gap-3">
                <Switch
                  id="generate-domain"
                  checked={generateDomain}
                  onCheckedChange={setGenerateDomain}
                />
                <Label htmlFor="generate-domain" className="text-sm">
                  Generate public URL
                </Label>
              </div>
              {generateDomain && (
                <>
                  <div className="flex items-center gap-2 ml-10">
                    <Globe2 className="size-4 text-muted-foreground shrink-0" />
                    <span className="text-sm font-mono text-muted-foreground truncate">
                      {domainPreview}
                    </span>
                    {!slugEdited && <button
                      type="button"
                      onClick={() => {
                        const wp = generateWordPair();
                        setWordPair(wp);
                        const base = selectedTemplate ? slugify(selectedTemplate.name) : slugify(displayName);
                        setName(`${base}-${wp.adjective}-${wp.noun}`);
                      }}
                      className="shrink-0 ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                      title="Generate new words"
                    >
                      <RefreshCw className="size-3.5" />
                    </button>}
                  </div>
                  <p className="text-xs text-muted-foreground ml-10">
                    You can add custom domains or change this after creation.
                  </p>
                </>
              )}
            </div>

            {/* Branch — for GitHub, shown after repo selected */}
            {selectedSource === "github" && selectedRepo && (
              <div className="grid gap-2 sm:w-1/3">
                <Label>Branch</Label>
                <BranchSelect
                  value={gitBranch}
                  onChange={setGitBranch}
                  branches={branches}
                />
              </div>
            )}

            {/* Image name — for "Image" source */}
            {selectedSource === "image" && (
              <div className="grid gap-2">
                <Label htmlFor="image-name">Image</Label>
                <Input
                  id="image-name"
                  placeholder="postgres:16, redis:7-alpine, nginx:latest"
                  value={imageName}
                  onChange={(e) => setImageName(e.target.value)}
                />
              </div>
            )}

            {/* Compose */}
            {selectedSource === "compose" && (
              <div className="grid gap-3">
                <div className="flex items-center gap-2">
                  <Label>Compose File</Label>
                  <div className="flex gap-1 rounded-lg border p-0.5 ml-auto">
                    <button
                      type="button"
                      onClick={() => { setContentMode("paste"); setSource("direct"); }}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        contentMode === "paste" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      Paste
                    </button>
                    <button
                      type="button"
                      onClick={() => { setContentMode("url"); setSource("git"); setGitMode("manual"); }}
                      className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                        contentMode === "url" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      From URL
                    </button>
                  </div>
                </div>
                {contentMode === "paste" ? (
                  <Textarea
                    id="compose-content"
                    placeholder={"services:\n  app:\n    image: nginx:latest\n    ports:\n      - '80:80'\n\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: secret"}
                    value={composeContent}
                    onChange={(e) => setComposeContent(e.target.value)}
                    rows={14}
                    className="font-mono text-sm leading-relaxed"
                    autoFocus
                  />
                ) : (
                  <div className="grid gap-4 sm:grid-cols-3">
                    <div className="grid gap-2 sm:col-span-2">
                      <Input placeholder="https://github.com/user/repo.git" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} autoFocus />
                    </div>
                    <div className="grid gap-2">
                      <Input placeholder="main" value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Environment Variables */}
            <div className="grid gap-2">
              <Label>Environment Variables</Label>
              <EnvEditor
                standalone
                initialContent={envContent}
                onChange={setEnvContent}
              />
            </div>

            {/* Port */}
            {(selectedSource === "image" || selectedTemplate || selectedSource === "compose") && (
              <div className="grid gap-2 sm:w-1/4">
                <Label htmlFor="port">Port</Label>
                <Input
                  id="port"
                  type="number"
                  placeholder="3000"
                  value={containerPort}
                  onChange={(e) => setContainerPort(e.target.value)}
                />
              </div>
            )}

            {/* Resource Limits */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <Label htmlFor="cpu-limit">CPU Limit (cores)</Label>
                <Input id="cpu-limit" type="number" step="0.1" min="0.1" placeholder="No limit" value={cpuLimit} onChange={(e) => setCpuLimit(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="memory-limit">Memory Limit (MB)</Label>
                <Input id="memory-limit" type="number" step="64" min="64" placeholder="No limit" value={memoryLimit} onChange={(e) => setMemoryLimit(e.target.value)} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="disk-write-threshold">Disk Write Alert (GB/hr)</Label>
                <Input id="disk-write-threshold" type="number" step="0.5" min="0.1" placeholder="Default: 1 GB" value={diskWriteAlertThreshold} onChange={(e) => setDiskWriteAlertThreshold(e.target.value)} />
                <p className="text-xs text-muted-foreground">{diskWriteAlertThreshold ? diskWriteAlertThreshold + " GB/hr" : "Default: 1 GB/hr"}</p>
              </div>
            </div>

            {/* Root directory — only for git/repo sources */}
            {(selectedSource === "github" || (selectedSource === "compose" && contentMode === "url")) && (
              <div className="grid gap-2 sm:w-2/3">
                <Label htmlFor="root-dir">Root Directory</Label>
                <Input id="root-dir" placeholder="./ (default)" value={rootDirectory} onChange={(e) => setRootDirectory(e.target.value)} />
              </div>
            )}

            {/* Description */}
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" placeholder="Optional" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
            </div>

            {/* Toggles */}
            <div className="grid gap-3">
              <div className="flex items-center gap-3">
                <Switch id="persist-data" checked={persistData} onCheckedChange={setPersistData} />
                <div>
                  <Label htmlFor="persist-data">Persistent Storage</Label>
                  {templateVolumes.length > 0 && persistData && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {templateVolumes.map((v) => v.mountPath).join(", ")}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch id="expose-port" checked={exposePort} onCheckedChange={setExposePort} />
                <div>
                  <Label htmlFor="expose-port">Expose Port</Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Map to a public host port for external access (e.g. database tools)
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Switch id="auto-deploy" checked={autoDeploy} onCheckedChange={setAutoDeploy} />
                <Label htmlFor="auto-deploy">Auto Deploy</Label>
              </div>

              {/* Create GitHub repo — only for non-git sources with GitHub connected */}
              {installations.length > 0 && source !== "git" && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      id="create-repo"
                      checked={createRepo}
                      onCheckedChange={setCreateRepo}
                    />
                    <div>
                      <Label htmlFor="create-repo">Create GitHub repository</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Create a new repo on {installations[0]?.accountLogin || "GitHub"}
                      </p>
                    </div>
                  </div>
                  {createRepo && installations.length > 1 && (
                    <div className="grid gap-2 ml-10">
                      <Label>GitHub Account</Label>
                      <Select
                        value={selectedInstallation || installations[0]?.id}
                        onValueChange={setSelectedInstallation}
                      >
                        <SelectTrigger className="w-64">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {installations.map((inst) => (
                            <SelectItem key={inst.id} value={inst.id}>
                              {inst.accountLogin}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              )}

              <div className="grid gap-2">
                <Label>Project</Label>
                <Select
                  value={parentId ?? ""}
                  onValueChange={setParentId}
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {parentApps.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="flex items-center gap-2">
                          <span className="size-2 rounded-full" style={{ backgroundColor: p.color }} />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                  </Select>
                </div>
            </div>

              </>
            )}
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              onClick={handleSubmit}
              disabled={creating || !displayName.trim() || !name.trim() || hasRequiredEnvVars}
            >
              {creating ? (
                <><Loader2 className="mr-2 size-4 animate-spin" />Creating...</>
              ) : (
                "Create App"
              )}
            </Button>
            <Button variant="ghost" onClick={() => router.push("/projects")}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
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
  Eye,
  EyeOff,
  Shuffle,
} from "lucide-react";
import { toast } from "sonner";
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

type GroupOption = {
  id: string;
  name: string;
  color: string;
};

type Props = {
  orgId: string;
  orgSlug: string;
  templates: Template[];
  groups?: GroupOption[];
  defaultGroupId?: string;
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
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function isPasswordField(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes("password") || lower.includes("secret") || lower.includes("_key") || lower === "app_keys" || lower.includes("jwt");
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function NewProjectFlow({ orgId, orgSlug, templates, groups = [], defaultGroupId }: Props) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);

  // What was selected
  const [selectedSource, setSelectedSource] = useState<SourceOption | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);

  // Form fields
  const [displayName, setDisplayName] = useState("");
  const [name, setName] = useState("");
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
  const [groupId, setGroupId] = useState<string | null>(defaultGroupId ?? null);
  const [persistData, setPersistData] = useState(true);
  const [templateVolumes, setTemplateVolumes] = useState<
    { name: string; mountPath: string; description: string }[]
  >([]);
  const [templateConnectionInfo, setTemplateConnectionInfo] = useState<
    { label: string; value: string; copyRef?: string }[]
  >([]);
  const [exposePort, setExposePort] = useState(false);

  // Domain
  const [generateDomain, setGenerateDomain] = useState(true);
  const [wordPair, setWordPair] = useState(() => generateWordPair());
  const baseDomain = getBaseDomain();

  // Template env vars
  const [templateEnvVars, setTemplateEnvVars] = useState<
    { key: string; value: string; description: string; required: boolean }[]
  >([]);
  const [maskedFields, setMaskedFields] = useState<Set<string>>(new Set());

  // GitHub state
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [installationsLoading, setInstallationsLoading] = useState(false);
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesLoading, setBranchesLoading] = useState(false);

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
      } catch { if (!cancelled) toast.error("Failed to fetch repositories"); }
      finally { if (!cancelled) setReposLoading(false); }
    }
    fetchRepos();
    return () => { cancelled = true; };
  }, [selectedInstallation]);

  // Auto-fetch installations when GitHub source is selected
  useEffect(() => {
    if (selectedSource === "github" || gitMode === "github") fetchInstallations();
  }, [selectedSource, gitMode, fetchInstallations]);

  // Fetch branches when a repo is selected
  useEffect(() => {
    if (!selectedRepo || !selectedInstallation) { setBranches([]); return; }
    let cancelled = false;
    async function fetchBranches() {
      setBranchesLoading(true);
      try {
        const res = await fetch(`/api/v1/github/branches?installationId=${selectedInstallation}&repo=${selectedRepo}`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          setBranches(data.branches || []);
        }
      } catch { /* noop */ }
      finally { if (!cancelled) setBranchesLoading(false); }
    }
    fetchBranches();
    return () => { cancelled = true; };
  }, [selectedRepo, selectedInstallation]);

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
    setName(slugify(template.name));
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
    if (template.defaultEnvVars?.length) {
      const masked = new Set<string>();
      const slug = slugify(template.name);
      setTemplateEnvVars(template.defaultEnvVars.map((ev) => {
        // Auto-generate passwords and secrets
        if (isPasswordField(ev.key) && !ev.defaultValue) {
          masked.add(ev.key);
          return { key: ev.key, value: generatePassword(), description: ev.description, required: ev.required };
        }
        // Default database name and username to the project slug
        const lower = ev.key.toLowerCase();
        if (!ev.defaultValue && (lower.includes("_database") || lower.includes("_db") || lower.includes("_user") || lower === "database__client")) {
          if (lower.includes("_user")) {
            return { key: ev.key, value: slug, description: ev.description, required: ev.required };
          }
          if (lower.includes("_database") || lower.includes("_db")) {
            return { key: ev.key, value: slug, description: ev.description, required: ev.required };
          }
        }
        return { key: ev.key, value: ev.defaultValue || "", description: ev.description, required: ev.required };
      }));
      setMaskedFields(masked);
    } else {
      setTemplateEnvVars([]);
      setMaskedFields(new Set());
    }
  }

  function selectSource(opt: SourceOption) {
    setSelectedSource(opt);
    setSelectedTemplate(null);
    setTemplateEnvVars([]);
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
    setTemplateEnvVars([]);
    setGenerateDomain(true);
    setDisplayName(""); setName(""); setDescription("");
    setSlugEdited(false);
  }

  const projectSlug = name || "my-app";
  const domainPreview = `${projectSlug}-${wordPair.adjective}-${wordPair.noun}.${baseDomain}`;

  const isConfiguring = selectedSource !== null || selectedTemplate !== null;
  const hasRequiredEnvVars = templateEnvVars.some((v) => v.required && !v.value.trim());

  async function handleSubmit() {
    if (!displayName.trim() || !name.trim()) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        displayName: displayName.trim(), name: name.trim(),
        description: description.trim() || undefined,
        source, deployType, autoTraefikLabels: true, autoDeploy, generateDomain,
        groupId: groupId || undefined,
        persistentVolumes: persistData && templateVolumes.length > 0
          ? templateVolumes.map((v) => ({ name: v.name, mountPath: v.mountPath }))
          : undefined,
        connectionInfo: templateConnectionInfo.length > 0 ? templateConnectionInfo : undefined,
        exposedPorts: exposePort && containerPort
          ? [{ internal: parseInt(containerPort, 10), description: "Primary port" }]
          : undefined,
      };
      if (containerPort) body.containerPort = parseInt(containerPort, 10);
      if (rootDirectory.trim()) body.rootDirectory = rootDirectory.trim();
      if (source === "git") { body.gitUrl = gitUrl; body.gitBranch = gitBranch; }
      if (deployType === "image") body.imageName = imageName;
      if (source === "direct" && deployType === "compose") {
        body.composeContent = composeContent || undefined;
      }

      const res = await fetch(`/api/v1/organizations/${orgId}/projects`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create project");
        return;
      }

      const { project } = await res.json();

      // Bulk-create env vars from template
      const filledVars = templateEnvVars.filter((v) => v.value.trim());
      if (filledVars.length > 0) {
        await fetch(`/api/v1/organizations/${orgId}/projects/${project.id}/env-vars`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vars: filledVars.map((v) => ({ key: v.key, value: v.value, isSecret: isPasswordField(v.key) })) }),
        });
      }

      if (autoDeploy) {
        toast.success("Project created — deploying...");
      } else {
        toast.success("Project created");
      }
      router.push(`/projects/${project.name}`);
    } catch { toast.error("Failed to create project"); }
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
        <h1 className="text-2xl font-semibold tracking-tight">New Project</h1>
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
                  : SOURCE_OPTIONS.find((s) => s.id === selectedSource)?.label || "New Project"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {selectedTemplate?.description || "Configure your project."}
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
                  <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-8 text-center">
                    <Github className="size-6 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">No GitHub account connected.</p>
                    <Button size="sm" variant="outline" asChild>
                      <Link href="/profile"><Github className="mr-1.5 size-4" />Connect in Profile</Link>
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
                    if (!slugEdited) setName(slugify(e.target.value));
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
                  }}
                />
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
                    <button
                      type="button"
                      onClick={() => setWordPair(generateWordPair())}
                      className="shrink-0 ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors"
                      title="Generate new words"
                    >
                      <RefreshCw className="size-3.5" />
                    </button>
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
                {branchesLoading ? (
                  <div className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Loading...</span>
                  </div>
                ) : branches.length > 0 ? (
                  <Select value={gitBranch} onValueChange={setGitBranch}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select branch" />
                    </SelectTrigger>
                    <SelectContent>
                      {branches.map((b) => (
                        <SelectItem key={b} value={b}>{b}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input value={gitBranch} onChange={(e) => setGitBranch(e.target.value)} placeholder="main" />
                )}
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

            {/* Template env vars */}
            {templateEnvVars.length > 0 && (
              <div className="grid gap-3">
                <Label>Environment Variables</Label>
                <div className="grid gap-3">
                  {templateEnvVars.map((ev, i) => {
                    const isPassword = isPasswordField(ev.key);
                    const isMasked = maskedFields.has(ev.key);
                    return (
                      <div key={ev.key} className="grid gap-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">{ev.key}</span>
                          {ev.required && <Badge variant="secondary" className="text-[10px] px-1 py-0">required</Badge>}
                          {isPassword && ev.value && (
                            <span className="text-[10px] text-status-success">auto-generated</span>
                          )}
                        </div>
                        <div className="flex gap-1">
                          <Input
                            placeholder={ev.description}
                            type={isPassword && isMasked ? "password" : "text"}
                            value={ev.value}
                            onChange={(e) => {
                              const updated = [...templateEnvVars];
                              updated[i] = { ...updated[i], value: e.target.value };
                              setTemplateEnvVars(updated);
                            }}
                            className="font-mono text-sm"
                          />
                          {isPassword && (
                            <>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="shrink-0 px-2"
                                onClick={() => setMaskedFields((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(ev.key)) next.delete(ev.key);
                                  else next.add(ev.key);
                                  return next;
                                })}
                                title={isMasked ? "Show" : "Hide"}
                              >
                                {isMasked ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="shrink-0 px-2"
                                onClick={() => {
                                  const updated = [...templateEnvVars];
                                  updated[i] = { ...updated[i], value: generatePassword() };
                                  setTemplateEnvVars(updated);
                                }}
                                title="Regenerate"
                              >
                                <Shuffle className="size-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  You can add more variables after creation.
                </p>
              </div>
            )}

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

              {groups.length > 0 && (
                <div className="grid gap-2">
                  <Label>Group</Label>
                  <Select
                    value={groupId ?? "__none"}
                    onValueChange={(v) => setGroupId(v === "__none" ? null : v)}
                  >
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="No group" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none">No group</SelectItem>
                      {groups.map((g) => (
                        <SelectItem key={g.id} value={g.id}>
                          <span className="flex items-center gap-2">
                            <span className="size-2 rounded-full" style={{ backgroundColor: g.color }} />
                            {g.name}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
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
                "Create Project"
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

"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth/client";
import { DEFAULT_APP_NAME } from "@/lib/app-name";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  Check,
  Circle,
  User,
  Mail,
  HardDrive,
  Github,
  Globe,
  Network,
  Rocket,
  Container,
  Upload,
  RefreshCw,
} from "lucide-react";
import { toast } from "@/lib/messenger";
import type { ProviderRestrictions } from "@/lib/config/provider-restrictions";
import {
  ProviderGuide,
  StepList,
  GuideLink,
  CopyableField,
  FieldHint,
  PermissionList,
} from "@/components/setup/provider-guide";
import {
  GITHUB_GUIDE,
  getWebhookUrl,
  EMAIL_PROVIDER_GUIDES,
  SMTP_PRESETS,
  BACKUP_PROVIDER_GUIDES,
  getDnsRecords,
} from "@/lib/setup/provider-guides";

const STEPS = [
  {
    id: "welcome",
    label: "Welcome",
    description: "Get started with Vardo",
    icon: Rocket,
  },
  {
    id: "account",
    label: "Create account",
    description: "Set up your admin credentials",
    icon: User,
    required: true,
  },
  {
    id: "email",
    label: "Email provider",
    description: "SMTP, Mailpace, or Resend",
    icon: Mail,
  },
  {
    id: "backup",
    label: "Backup storage",
    description: "S3, R2, or B2 for volume backups",
    icon: HardDrive,
  },
  {
    id: "github",
    label: "GitHub App",
    description: "Repository access and auto-deploy",
    icon: Github,
  },
  {
    id: "domain",
    label: "Domain & DNS",
    description: "Verify DNS records for HTTPS",
    icon: Globe,
  },
  {
    id: "instances",
    label: "Instances",
    description: "Connect to other Vardo instances",
    icon: Network,
  },
  {
    id: "done",
    label: "Ready to go",
    description: "Start deploying",
    icon: Rocket,
  },
] as const;

type StepId = (typeof STEPS)[number]["id"] | "import";

const STORAGE_KEY = "vardo-setup";

function loadProgress(): { step: StepId; completed: StepId[] } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveProgress(step: StepId, completed: Set<StepId>) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ step, completed: [...completed] }),
    );
  } catch {}
}

const DEFAULT_RESTRICTIONS: ProviderRestrictions = {
  allowSmtp: true,
  allowLocalBackups: true,
  allowPasswordAuth: true,
};

export function SetupWizard({
  meshEnabled = true,
  providerRestrictions = DEFAULT_RESTRICTIONS,
}: {
  meshEnabled?: boolean;
  providerRestrictions?: ProviderRestrictions;
}) {
  const router = useRouter();
  const steps = meshEnabled ? STEPS : STEPS.filter((s) => s.id !== "instances");
  const [currentStep, setCurrentStep] = useState<StepId>("welcome");
  const [loading, setLoading] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Restore progress: DB is source of truth, localStorage is fallback
  useEffect(() => {
    let cancelled = false;

    async function hydrate() {
      const local = loadProgress();
      const dbCompleted: Set<StepId> = new Set();

      try {
        const res = await fetch("/api/setup/progress");
        if (res.ok) {
          const data: Record<string, boolean> = await res.json();
          for (const [stepId, done] of Object.entries(data)) {
            if (done) dbCompleted.add(stepId as StepId);
          }
        }
      } catch {
        // Network failure — fall through to localStorage only
      }

      if (cancelled) return;

      // Merge: DB wins for step completion, union with localStorage
      const merged = new Set<StepId>([
        ...dbCompleted,
        ...(local?.completed ?? []),
      ]);

      // "welcome" is always implicitly complete if account exists
      if (dbCompleted.has("account" as StepId)) {
        merged.add("welcome");
      }

      setCompletedSteps(merged);

      // Resume at the first incomplete step
      const firstIncomplete = steps.find((s) => !merged.has(s.id));
      setCurrentStep(firstIncomplete?.id ?? "done");

      setHydrated(true);
    }

    hydrate();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist progress on every change
  useEffect(() => {
    if (hydrated) {
      saveProgress(currentStep, completedSteps);
    }
  }, [currentStep, completedSteps, hydrated]);

  if (!hydrated) return null;

  const currentIndex = steps.findIndex((s) => s.id === currentStep);

  function markComplete(step: StepId) {
    setCompletedSteps((prev) => new Set([...prev, step]));
  }

  function goNext() {
    const next = steps[currentIndex + 1];
    if (next) setCurrentStep(next.id);
  }

  function goTo(step: StepId) {
    const targetIndex = steps.findIndex((s) => s.id === step);
    if (
      targetIndex <= currentIndex ||
      completedSteps.has(steps[targetIndex - 1]?.id)
    ) {
      setCurrentStep(step);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center p-6 md:p-12">
      <div className="w-full max-w-4xl space-y-10">
        {/* Header — full width above both columns */}
        <div className="space-y-2">
          <div className="flex items-center gap-2.5">
            <Container className="size-6" />
            <span className="text-xl font-bold tracking-tight">Vardo</span>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed max-w-lg">
            Welcome to your self-hosted PaaS. This wizard walks you through
            the essentials. Everything after account creation is optional and
            can be configured later in Settings.
          </p>
        </div>

        {/* Two-column layout */}
        <div className="grid gap-12 md:grid-cols-[280px_1fr]">
          {/* Left column — steps */}
          <nav className="space-y-1">
            {steps.map((step, i) => {
              const Icon = step.icon;
              const isActive = step.id === currentStep;
              const isDone = completedSteps.has(step.id);
              const canClick =
                i <= currentIndex ||
                completedSteps.has(steps[i - 1]?.id);

              return (
                <button
                  key={step.id}
                  onClick={() => canClick && goTo(step.id)}
                  aria-current={isActive ? "step" : undefined}
                  disabled={!canClick}
                  aria-label={`${step.label}${isDone ? " (completed)" : ""}`}
                  className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? "bg-muted"
                      : canClick
                        ? "hover:bg-muted/50 cursor-pointer"
                        : "opacity-40 cursor-default"
                  }`}
                >
                  <div className="mt-0.5">
                    {isDone ? (
                      <div className="flex size-5 items-center justify-center rounded-full bg-primary">
                        <Check className="size-3 text-primary-foreground" />
                      </div>
                    ) : isActive ? (
                      <div className="flex size-5 items-center justify-center rounded-full border-2 border-primary">
                        <Circle className="size-2 fill-primary text-primary" />
                      </div>
                    ) : (
                      <div className="flex size-5 items-center justify-center rounded-full border border-muted-foreground/30">
                        <Icon className="size-3 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0">
                    <div
                      className={`text-sm font-medium ${isActive ? "text-foreground" : isDone ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      {step.label}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {step.description}
                    </div>
                  </div>
                </button>
              );
            })}
          </nav>

          {/* Right column — current step form */}
          <div className="w-full space-y-6">
            {currentStep === "welcome" && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-xl font-semibold">Welcome to Vardo</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    Deploy everything. Own everything.
                  </p>
                </div>
                <div className="grid gap-3">
                  <Button
                    variant="default"
                    className="w-full h-14 squircle rounded-lg justify-start px-4"
                    onClick={() => {
                      markComplete("welcome");
                      goNext();
                    }}
                  >
                    <Rocket className="w-5 h-5 mr-3 shrink-0" />
                    <div className="text-left">
                      <p className="text-sm font-medium">Fresh install</p>
                      <p className="text-xs opacity-80">
                        Create your account and configure services
                      </p>
                    </div>
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full h-14 squircle rounded-lg justify-start px-4"
                    onClick={() => {
                      markComplete("welcome");
                      setCurrentStep("import" as StepId);
                    }}
                  >
                    <Upload className="w-5 h-5 mr-3 shrink-0" />
                    <div className="text-left">
                      <p className="text-sm font-medium">Restore from backup</p>
                      <p className="text-xs text-muted-foreground">
                        Import a config from a previous Vardo installation
                      </p>
                    </div>
                  </Button>
                </div>
              </div>
            )}
            {currentStep === ("import" as StepId) && (
              <ImportStep
                loading={loading}
                setLoading={setLoading}
                onComplete={(importedSections) => {
                  // Mark config steps as complete if they were imported
                  const sectionToStep: Record<string, StepId> = {
                    email: "email",
                    backup: "backup",
                    github: "github",
                  };
                  for (const section of importedSections) {
                    const stepId = sectionToStep[section];
                    if (stepId) markComplete(stepId);
                  }
                  setCurrentStep("account");
                }}
                onSkip={() => {
                  setCurrentStep("account");
                }}
              />
            )}
            {currentStep === "account" && (
              <AccountStep
                loading={loading}
                setLoading={setLoading}
                onComplete={() => {
                  markComplete("account");
                  goNext();
                }}
              />
            )}
            {currentStep === "email" && (
              <EmailStep
                loading={loading}
                setLoading={setLoading}
                allowSmtp={providerRestrictions.allowSmtp}
                onComplete={() => {
                  markComplete("email");
                  goNext();
                }}
                onSkip={() => {
                  markComplete("email");
                  goNext();
                }}
              />
            )}
            {currentStep === "backup" && (
              <BackupStep
                loading={loading}
                setLoading={setLoading}
                onComplete={() => {
                  markComplete("backup");
                  goNext();
                }}
                onSkip={() => {
                  markComplete("backup");
                  goNext();
                }}
              />
            )}
            {currentStep === "github" && (
              <GithubStep
                loading={loading}
                setLoading={setLoading}
                onComplete={() => {
                  markComplete("github");
                  goNext();
                }}
                onSkip={() => {
                  markComplete("github");
                  goNext();
                }}
              />
            )}
            {currentStep === "domain" && (
              <DomainStep
                onComplete={() => {
                  markComplete("domain");
                  goNext();
                }}
                onSkip={() => {
                  markComplete("domain");
                  goNext();
                }}
              />
            )}
            {currentStep === "instances" && (
              <InstancesStep
                loading={loading}
                setLoading={setLoading}
                onComplete={() => {
                  markComplete("instances");
                  goNext();
                }}
                onSkip={() => {
                  markComplete("instances");
                  goNext();
                }}
              />
            )}
            {currentStep === "done" && (
              <DoneStep
                onFinish={() => {
                  localStorage.removeItem(STORAGE_KEY);
                  router.push("/projects");
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 0: Import Config
// ---------------------------------------------------------------------------

function ImportStep({
  loading,
  setLoading,
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  onComplete: (importedSections: string[]) => void;
  onSkip: () => void;
}) {
  async function handleFile(file: File) {
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const res = await fetch("/api/v1/admin/config/import?persist=true", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const text = await res.text();
        let message = "Import failed";
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }

      const data = await res.json();
      toast.success(`Config imported: ${data.imported.join(", ")}`);

      if (data.missingSecrets?.length > 0) {
        toast.error(`Some secrets are missing and will need to be configured: ${data.missingSecrets.join(", ")}`);
      }

      onComplete(data.imported);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-2">
        <div className="text-sm font-medium">Restoring from a previous installation?</div>
        <p className="text-xs text-muted-foreground">
          Upload a vardo.yml, vardo.secrets.yml, or vardo.zip exported from
          another instance. This will pre-fill your email, backup, GitHub, and
          feature flag settings.
        </p>
      </div>

      <label className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 cursor-pointer hover:bg-muted/50 transition-colors">
        <Upload className="size-6 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">
          {loading ? "Importing..." : "Drop a config file or click to upload"}
        </span>
        <span className="text-xs text-muted-foreground">
          .yml, .yaml, or .zip
        </span>
        <input
          type="file"
          accept=".yml,.yaml,.zip"
          className="sr-only"
          disabled={loading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
          }}
        />
      </label>

      <Button
        type="button"
        variant="outline"
        className="squircle w-full"
        onClick={onSkip}
      >
        Skip — start fresh
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1: Create Account
// ---------------------------------------------------------------------------

function AccountStep({
  loading,
  setLoading,
  onComplete,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  onComplete: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await signUp.email({ name, email, password });
      if (error) {
        toast.error(error.message || "Failed to create account");
        return;
      }
      toast.success("Account created — you're the admin");
      onComplete();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create account",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
      </div>
      <Button type="submit" className="squircle w-full" disabled={loading}>
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          "Create account"
        )}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 2: Email Provider
// ---------------------------------------------------------------------------

function EmailStep({
  loading,
  setLoading,
  allowSmtp = true,
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  allowSmtp?: boolean;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [provider, setProvider] = useState("resend");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState(DEFAULT_APP_NAME);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/setup/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          smtpHost,
          smtpPort: Number(smtpPort),
          smtpUser,
          smtpPass,
          apiKey,
          fromEmail,
          fromName,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Email provider saved");
      onComplete();
    } catch {
      toast.error("Failed to save email config");
    } finally {
      setLoading(false);
    }
  }

  const guide = EMAIL_PROVIDER_GUIDES[provider];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="resend">Resend</SelectItem>
            <SelectItem value="postmark">Postmark</SelectItem>
            <SelectItem value="mailpace">Mailpace</SelectItem>
            {allowSmtp && <SelectItem value="smtp">SMTP</SelectItem>}
          </SelectContent>
        </Select>
      </div>

      {guide && provider !== "smtp" && (
        <ProviderGuide title={`How to get your ${guide.name} API key`} description={guide.description}>
          <StepList steps={[
            `Sign up or log in at ${guide.name}`,
            guide.keyLocation,
            "Paste the key into the field below",
          ]} />
          <div className="flex gap-3">
            <GuideLink href={guide.signupUrl}>Sign up</GuideLink>
            <GuideLink href={guide.dashboardUrl}>Dashboard</GuideLink>
          </div>
        </ProviderGuide>
      )}

      {provider === "smtp" && allowSmtp && (
        <>
          <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
            SMTP provides no delivery tracking or bounce detection. If a
            notification fails to send, you won&apos;t know. We recommend
            Resend, Postmark, or Mailpace for reliable delivery.
          </p>
          <ProviderGuide title="Common SMTP settings">
            <div className="space-y-2">
              {SMTP_PRESETS.map((preset) => (
                <div key={preset.label} className="flex items-center justify-between text-xs">
                  <div>
                    <span className="font-medium">{preset.label}</span>
                    <span className="text-muted-foreground ml-2">{preset.host}:{preset.port}</span>
                  </div>
                  <span className="text-muted-foreground text-[11px]">{preset.note}</span>
                </div>
              ))}
            </div>
          </ProviderGuide>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="smtpHost">SMTP Host</Label>
              <Input
                id="smtpHost"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="smtpPort">Port</Label>
              <Input
                id="smtpPort"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="smtpUser">Username</Label>
            <Input
              id="smtpUser"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="smtpPass">Password</Label>
            <Input
              id="smtpPass"
              type="password"
              value={smtpPass}
              onChange={(e) => setSmtpPass(e.target.value)}
              required
            />
          </div>
        </>
      )}
      {provider === "mailpace" && (
        <div className="space-y-2">
          <Label htmlFor="apiKey">Mailpace API Token</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
          <FieldHint>{EMAIL_PROVIDER_GUIDES.mailpace.keyLocation}</FieldHint>
        </div>
      )}
      {provider === "postmark" && (
        <div className="space-y-2">
          <Label htmlFor="apiKey">Postmark Server Token</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            required
          />
          <FieldHint>{EMAIL_PROVIDER_GUIDES.postmark.keyLocation}</FieldHint>
        </div>
      )}
      {provider === "resend" && (
        <div className="space-y-2">
          <Label htmlFor="apiKey">Resend API Key</Label>
          <Input
            id="apiKey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="re_..."
            required
          />
          <FieldHint>{EMAIL_PROVIDER_GUIDES.resend.keyLocation}</FieldHint>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="fromEmail">From email</Label>
          <Input
            id="fromEmail"
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="noreply@example.com"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fromName">From name</Label>
          <Input
            id="fromName"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="squircle flex-1"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button type="submit" className="squircle flex-1" disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 3: Backup Storage
// ---------------------------------------------------------------------------

function BackupStep({
  loading,
  setLoading,
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [type, setType] = useState("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/setup/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          bucket,
          region,
          endpoint,
          accessKey,
          secretKey,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Backup storage saved");
      onComplete();
    } catch {
      toast.error("Failed to save backup config");
    } finally {
      setLoading(false);
    }
  }

  const backupGuide = BACKUP_PROVIDER_GUIDES[type];

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label>Storage type</Label>
        <Select value={type} onValueChange={setType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="s3">AWS S3</SelectItem>
            <SelectItem value="r2">Cloudflare R2</SelectItem>
            <SelectItem value="b2">Backblaze B2</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {backupGuide && (
        <ProviderGuide title={`Setting up ${backupGuide.name}`} description={backupGuide.bucketSettings}>
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Credentials:</span> {backupGuide.credentialSteps}
            </div>
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Permissions needed:</span> {backupGuide.requiredPermissions}
            </div>
          </div>
          <div className="flex gap-3">
            <GuideLink href={backupGuide.createBucketUrl}>Create bucket</GuideLink>
            <GuideLink href={backupGuide.consoleUrl}>Console</GuideLink>
          </div>
        </ProviderGuide>
      )}

      <div className="space-y-2">
        <Label htmlFor="bucket">Bucket name</Label>
        <Input
          id="bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          required
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="region">Region</Label>
          <Input
            id="region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder={type === "r2" ? "auto" : "us-east-1"}
            required
          />
          {type === "r2" && <FieldHint>Use &quot;auto&quot; for R2 — it handles region routing automatically.</FieldHint>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="endpoint">Endpoint</Label>
          <Input
            id="endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={type === "s3" ? "Leave blank for AWS" : ""}
          />
          {type === "r2" && <FieldHint>https://&lt;account-id&gt;.r2.cloudflarestorage.com</FieldHint>}
          {type === "b2" && <FieldHint>https://s3.&lt;region&gt;.backblazeb2.com</FieldHint>}
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="accessKey">Access key</Label>
        <Input
          id="accessKey"
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="secretKey">Secret key</Label>
        <Input
          id="secretKey"
          type="password"
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          required
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="squircle flex-1"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button type="submit" className="squircle flex-1" disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 4: Optional Services
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 4: GitHub App
// ---------------------------------------------------------------------------

function GithubStep({
  loading,
  setLoading,
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [appId, setAppId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState(() => crypto.randomUUID());

  const appUrl = typeof window !== "undefined" ? window.location.origin : "";
  const webhookUrl = getWebhookUrl(appUrl);

  function regenerateWebhookSecret() {
    setWebhookSecret(crypto.randomUUID());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/setup/github", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId,
          appSlug,
          clientId,
          clientSecret,
          privateKey,
          webhookSecret,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("GitHub App saved");
      onComplete();
    } catch {
      toast.error("Failed to save GitHub config");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <ProviderGuide title="How to create a GitHub App" defaultOpen>
        <StepList steps={GITHUB_GUIDE.steps} />
        <PermissionList permissions={GITHUB_GUIDE.permissions} />
        <GuideLink href={GITHUB_GUIDE.createAppUrl}>Create GitHub App</GuideLink>
      </ProviderGuide>

      {webhookUrl && (
        <div className="space-y-2">
          <CopyableField label="Webhook URL (paste into GitHub)" value={webhookUrl} />
          <CopyableField label="Webhook secret (paste into GitHub)" value={webhookSecret} />
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="appId">App ID</Label>
          <Input
            id="appId"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            required
          />
          <FieldHint>{GITHUB_GUIDE.fieldHints.appId}</FieldHint>
        </div>
        <div className="space-y-2">
          <Label htmlFor="appSlug">App slug</Label>
          <Input
            id="appSlug"
            value={appSlug}
            onChange={(e) => setAppSlug(e.target.value)}
            required
          />
          <FieldHint>{GITHUB_GUIDE.fieldHints.appSlug}</FieldHint>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="ghClientId">Client ID</Label>
          <Input
            id="ghClientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            required
          />
          <FieldHint>{GITHUB_GUIDE.fieldHints.clientId}</FieldHint>
        </div>
        <div className="space-y-2">
          <Label htmlFor="ghClientSecret">Client secret</Label>
          <Input
            id="ghClientSecret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            required
          />
          <FieldHint>{GITHUB_GUIDE.fieldHints.clientSecret}</FieldHint>
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="privateKey">Private key (PEM)</Label>
        <textarea
          id="privateKey"
          className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          required
        />
        <FieldHint>{GITHUB_GUIDE.fieldHints.privateKey}</FieldHint>
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="webhookSecret">Webhook secret</Label>
          <button
            type="button"
            onClick={regenerateWebhookSecret}
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <RefreshCw className="size-3" />
            Regenerate
          </button>
        </div>
        <Input
          id="webhookSecret"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
          required
          className="font-mono text-sm"
        />
        <FieldHint>{GITHUB_GUIDE.fieldHints.webhookSecret}</FieldHint>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="squircle flex-1"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button type="submit" className="squircle flex-1" disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Save"}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Domain
// ---------------------------------------------------------------------------

function DomainStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [domain, setDomain] = useState("");
  const [baseDomain, setBaseDomain] = useState("");
  const [serverIp, setServerIp] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingIp, setLoadingIp] = useState(true);

  // Pre-fill server IP from existing config
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/setup/general");
        if (res.ok) {
          const data = await res.json();
          if (data.serverIp) setServerIp(data.serverIp);
          if (data.baseDomain) setBaseDomain(data.baseDomain);
          if (data.domain) setDomain(data.domain);
        }
      } catch {
        // best effort
      } finally {
        setLoadingIp(false);
      }
    })();
  }, []);

  const dnsRecords = getDnsRecords(baseDomain, serverIp);

  async function handleSave() {
    setSaving(true);
    try {
      // Fetch existing config to preserve instanceName
      const existing = await fetch("/api/setup/general").then((r) => r.json()).catch(() => ({}));
      const res = await fetch("/api/setup/general", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceName: existing.instanceName || "Vardo",
          domain: domain || undefined,
          baseDomain: baseDomain || undefined,
          serverIp: serverIp || undefined,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      onComplete();
    } catch {
      toast.error("Failed to save domain settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <ProviderGuide title="DNS setup instructions" defaultOpen>
        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Point your domain to this server so Vardo can issue SSL certificates
            and route traffic to your apps. You need two A records:
          </p>
          <div className="rounded border bg-muted/30 p-2 font-mono space-y-1">
            {dnsRecords.map((r) => (
              <div key={r.name}>
                {r.type} &nbsp; {r.name} &nbsp; → &nbsp; {r.value}
              </div>
            ))}
          </div>
          <p>
            The wildcard record (*.domain) enables automatic subdomains for every
            app you deploy. HTTPS activates automatically once DNS propagates.
          </p>
        </div>
      </ProviderGuide>

      <div className="space-y-3">
        <div className="space-y-2">
          <Label htmlFor="setup-domain">Primary domain</Label>
          <Input
            id="setup-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="vardo.example.com"
          />
          <FieldHint>The domain where this Vardo instance will be accessible.</FieldHint>
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-base-domain">Base domain</Label>
          <Input
            id="setup-base-domain"
            value={baseDomain}
            onChange={(e) => setBaseDomain(e.target.value)}
            placeholder="example.com"
          />
          <FieldHint>Wildcard domain for auto-generated app subdomains.</FieldHint>
        </div>
        <div className="space-y-2">
          <Label htmlFor="setup-server-ip">Server IP</Label>
          <Input
            id="setup-server-ip"
            value={loadingIp ? "" : serverIp}
            onChange={(e) => setServerIp(e.target.value)}
            placeholder={loadingIp ? "Detecting..." : "203.0.113.1"}
            disabled={loadingIp}
          />
          <FieldHint>
            {serverIp
              ? `Detected: ${serverIp} — point your DNS A records here.`
              : "Public IP of this server. Point your DNS A records here."}
          </FieldHint>
        </div>
      </div>

      <div className="flex gap-2">
        <Button
          variant="outline"
          className="squircle flex-1"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button
          className="squircle flex-1"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</>
          ) : (
            "Save & continue"
          )}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 6: Instances
// ---------------------------------------------------------------------------

function InstancesStep({
  loading,
  setLoading,
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [token, setToken] = useState("");
  const [joined, setJoined] = useState(false);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/v1/admin/mesh/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!res.ok) {
        const text = await res.text();
        let message = "Failed to join";
        try { message = JSON.parse(text).error || message; } catch {}
        throw new Error(message);
      }
      toast.success("Connected to instance");
      setJoined(true);
      onComplete();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to join mesh",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-2">
        <div className="text-sm font-medium">What are instances?</div>
        <p className="text-xs text-muted-foreground">
          Connect multiple Vardo installations over encrypted WireGuard
          tunnels. Manage projects across dev, staging and production
          from a single dashboard.
        </p>
      </div>

      <form onSubmit={handleJoin} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="inviteToken">Invite token</Label>
          <Input
            id="inviteToken"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste an invite token from another instance"
            required
          />
          <p className="text-xs text-muted-foreground">
            Generate an invite token on the instance you want to connect
            to, then paste it here.
          </p>
        </div>

        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            className="squircle flex-1"
            onClick={onSkip}
          >
            Skip
          </Button>
          <Button
            type="submit"
            className="squircle flex-1"
            disabled={loading || joined || !token.trim()}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : "Join"}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 7: Done
// ---------------------------------------------------------------------------

function DoneStep({ onFinish }: { onFinish: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">
          You&apos;re all set
        </h2>
        <p className="text-sm text-muted-foreground">
          Vardo is ready. Deploy your first app or explore the dashboard.
          Any skipped steps can be configured later in Settings.
        </p>
      </div>
      <Button className="squircle w-full" size="lg" onClick={onFinish}>
        Go to dashboard
      </Button>
    </div>
  );
}

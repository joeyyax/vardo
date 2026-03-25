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
} from "lucide-react";
import { toast } from "@/lib/messenger";

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

export function SetupWizard({ meshEnabled = true }: { meshEnabled?: boolean }) {
  const router = useRouter();
  const steps = meshEnabled ? STEPS : STEPS.filter((s) => s.id !== "instances");
  const [currentStep, setCurrentStep] = useState<StepId>("welcome");
  const [loading, setLoading] = useState(false);
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(new Set());
  const [hydrated, setHydrated] = useState(false);

  // Restore progress from localStorage on mount
  useEffect(() => {
    const saved = loadProgress();
    if (saved) {
      setCompletedSteps(new Set(saved.completed));
      setCurrentStep(saved.step);
    }
    setHydrated(true);
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
              <DoneStep onFinish={() => router.push("/projects")} />
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
  onComplete,
  onSkip,
}: {
  loading: boolean;
  setLoading: (v: boolean) => void;
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
            <SelectItem value="smtp">SMTP</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {provider === "smtp" && (
        <>
          <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
            SMTP provides no delivery tracking or bounce detection. If a
            notification fails to send, you won&apos;t know. We recommend
            Resend, Postmark, or Mailpace for reliable delivery.
          </p>
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
        </div>
        <div className="space-y-2">
          <Label htmlFor="endpoint">Endpoint</Label>
          <Input
            id="endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={type === "s3" ? "Leave blank for AWS" : ""}
          />
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
  const [webhookSecret, setWebhookSecret] = useState("");

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
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="appId">App ID</Label>
          <Input
            id="appId"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="appSlug">App slug</Label>
          <Input
            id="appSlug"
            value={appSlug}
            onChange={(e) => setAppSlug(e.target.value)}
            required
          />
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
      </div>
      <div className="space-y-2">
        <Label htmlFor="webhookSecret">Webhook secret</Label>
        <Input
          id="webhookSecret"
          type="password"
          value={webhookSecret}
          onChange={(e) => setWebhookSecret(e.target.value)}
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
// Step 6: Domain
// ---------------------------------------------------------------------------

function DomainStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4 space-y-3">
        <div className="text-sm font-medium">Required DNS records</div>
        <div className="space-y-1 font-mono text-xs text-muted-foreground">
          <div>
            A &nbsp;&nbsp; your-domain.com &nbsp;&nbsp; → &nbsp; this server IP
          </div>
          <div>
            A &nbsp;&nbsp; *.your-domain.com → &nbsp; this server IP
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          HTTPS will activate automatically once DNS propagates and Let&apos;s
          Encrypt issues certificates.
        </p>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="squircle flex-1"
          onClick={onSkip}
        >
          Skip
        </Button>
        <Button className="squircle flex-1" onClick={onComplete}>
          DNS is configured
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

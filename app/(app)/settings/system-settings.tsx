"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const MASK_PREFIX = "••••";

function isMasked(value: string | null | undefined): boolean {
  if (!value) return true;
  return value.startsWith(MASK_PREFIX);
}

// ---------------------------------------------------------------------------
// Email Settings
// ---------------------------------------------------------------------------

function EmailSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);

  const [provider, setProvider] = useState("smtp");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("Vardo");

  // Track which masked fields the user has clicked to edit
  const [editingSmtpPass, setEditingSmtpPass] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/email");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.configured) {
        setConfigured(true);
        setProvider(data.provider || "smtp");
        setSmtpHost(data.smtpHost || "");
        setSmtpPort(data.smtpPort?.toString() || "587");
        setSmtpUser(data.smtpUser || "");
        setSmtpPass(data.smtpPass || "");
        setApiKey(data.apiKey || "");
        setFromEmail(data.fromEmail || "");
        setFromName(data.fromName || "Vardo");
      }
    } catch {
      // Not configured — leave defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/setup/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          smtpHost,
          smtpPort: Number(smtpPort),
          smtpUser,
          smtpPass: editingSmtpPass ? smtpPass : smtpPass,
          apiKey: editingApiKey ? apiKey : apiKey,
          fromEmail,
          fromName,
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Email settings saved");
      setConfigured(true);
      // Reset editing state and re-fetch to get masked values back
      setEditingSmtpPass(false);
      setEditingApiKey(false);
      fetchConfig();
    } catch {
      toast.error("Failed to save email settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      {configured && (
        <p className="text-xs text-muted-foreground">
          Email is configured. Edit fields below to update.
        </p>
      )}

      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={provider} onValueChange={setProvider}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="smtp">SMTP</SelectItem>
            <SelectItem value="mailpace">Mailpace</SelectItem>
            <SelectItem value="resend">Resend</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {provider === "smtp" && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="sys-smtpHost">SMTP Host</Label>
              <Input
                id="sys-smtpHost"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sys-smtpPort">Port</Label>
              <Input
                id="sys-smtpPort"
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="sys-smtpUser">Username</Label>
            <Input
              id="sys-smtpUser"
              value={smtpUser}
              onChange={(e) => setSmtpUser(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sys-smtpPass">Password</Label>
            {isMasked(smtpPass) && !editingSmtpPass ? (
              <div className="flex gap-2">
                <Input
                  id="sys-smtpPass"
                  value={smtpPass}
                  disabled
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  onClick={() => {
                    setEditingSmtpPass(true);
                    setSmtpPass("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : (
              <Input
                id="sys-smtpPass"
                type="password"
                value={smtpPass}
                onChange={(e) => setSmtpPass(e.target.value)}
                required
                autoFocus={editingSmtpPass}
              />
            )}
          </div>
        </>
      )}

      {provider === "mailpace" && (
        <div className="space-y-2">
          <Label htmlFor="sys-apiKey">Mailpace API Token</Label>
          {isMasked(apiKey) && !editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-apiKey"
                value={apiKey}
                disabled
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                onClick={() => {
                  setEditingApiKey(true);
                  setApiKey("");
                }}
              >
                Edit
              </Button>
            </div>
          ) : (
            <Input
              id="sys-apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
              autoFocus={editingApiKey}
            />
          )}
        </div>
      )}

      {provider === "resend" && (
        <div className="space-y-2">
          <Label htmlFor="sys-apiKey">Resend API Key</Label>
          {isMasked(apiKey) && !editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-apiKey"
                value={apiKey}
                disabled
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                onClick={() => {
                  setEditingApiKey(true);
                  setApiKey("");
                }}
              >
                Edit
              </Button>
            </div>
          ) : (
            <Input
              id="sys-apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="re_..."
              required
              autoFocus={editingApiKey}
            />
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="sys-fromEmail">From email</Label>
          <Input
            id="sys-fromEmail"
            type="email"
            value={fromEmail}
            onChange={(e) => setFromEmail(e.target.value)}
            placeholder="noreply@example.com"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sys-fromName">From name</Label>
          <Input
            id="sys-fromName"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
      </div>

      <Button type="submit" className="squircle" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Backup Settings
// ---------------------------------------------------------------------------

function BackupSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);

  const [type, setType] = useState("s3");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");

  const [editingAccessKey, setEditingAccessKey] = useState(false);
  const [editingSecretKey, setEditingSecretKey] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/backup");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.configured) {
        setConfigured(true);
        setType(data.type || "s3");
        setBucket(data.bucket || "");
        setRegion(data.region || "");
        setEndpoint(data.endpoint || "");
        setAccessKey(data.accessKey || "");
        setSecretKey(data.secretKey || "");
      }
    } catch {
      // Not configured
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/setup/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, bucket, region, endpoint, accessKey, secretKey }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Backup settings saved");
      setConfigured(true);
      setEditingAccessKey(false);
      setEditingSecretKey(false);
      fetchConfig();
    } catch {
      toast.error("Failed to save backup settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      {configured && (
        <p className="text-xs text-muted-foreground">
          Backup storage is configured. Edit fields below to update.
        </p>
      )}

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
        <Label htmlFor="sys-bucket">Bucket name</Label>
        <Input
          id="sys-bucket"
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="sys-region">Region</Label>
          <Input
            id="sys-region"
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            placeholder={type === "r2" ? "auto" : "us-east-1"}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sys-endpoint">Endpoint</Label>
          <Input
            id="sys-endpoint"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={type === "s3" ? "Leave blank for AWS" : ""}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-accessKey">Access key</Label>
        {isMasked(accessKey) && !editingAccessKey ? (
          <div className="flex gap-2">
            <Input
              id="sys-accessKey"
              value={accessKey}
              disabled
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="squircle shrink-0"
              onClick={() => {
                setEditingAccessKey(true);
                setAccessKey("");
              }}
            >
              Edit
            </Button>
          </div>
        ) : (
          <Input
            id="sys-accessKey"
            value={accessKey}
            onChange={(e) => setAccessKey(e.target.value)}
            required
            autoFocus={editingAccessKey}
          />
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-secretKey">Secret key</Label>
        {isMasked(secretKey) && !editingSecretKey ? (
          <div className="flex gap-2">
            <Input
              id="sys-secretKey"
              value={secretKey}
              disabled
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="squircle shrink-0"
              onClick={() => {
                setEditingSecretKey(true);
                setSecretKey("");
              }}
            >
              Edit
            </Button>
          </div>
        ) : (
          <Input
            id="sys-secretKey"
            type="password"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            required
            autoFocus={editingSecretKey}
          />
        )}
      </div>

      <Button type="submit" className="squircle" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// GitHub App Settings
// ---------------------------------------------------------------------------

function GitHubSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [configured, setConfigured] = useState(false);

  const [appId, setAppId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const [editingClientSecret, setEditingClientSecret] = useState(false);
  const [editingPrivateKey, setEditingPrivateKey] = useState(false);
  const [editingWebhookSecret, setEditingWebhookSecret] = useState(false);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/setup/github");
      if (!res.ok) throw new Error("Failed to fetch");
      const data = await res.json();
      if (data.configured) {
        setConfigured(true);
        setAppId(data.appId || "");
        setAppSlug(data.appSlug || "");
        setClientId(data.clientId || "");
        setClientSecret(data.clientSecret || "");
        setPrivateKey(data.privateKey || "");
        setWebhookSecret(data.webhookSecret || "");
      }
    } catch {
      // Not configured
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
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
      toast.success("GitHub App settings saved");
      setConfigured(true);
      setEditingClientSecret(false);
      setEditingPrivateKey(false);
      setEditingWebhookSecret(false);
      fetchConfig();
    } catch {
      toast.error("Failed to save GitHub settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      {configured && (
        <p className="text-xs text-muted-foreground">
          GitHub App is configured. Edit fields below to update.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="sys-appId">App ID</Label>
          <Input
            id="sys-appId"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sys-appSlug">App slug</Label>
          <Input
            id="sys-appSlug"
            value={appSlug}
            onChange={(e) => setAppSlug(e.target.value)}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-2">
          <Label htmlFor="sys-ghClientId">Client ID</Label>
          <Input
            id="sys-ghClientId"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sys-ghClientSecret">Client secret</Label>
          {isMasked(clientSecret) && !editingClientSecret ? (
            <div className="flex gap-2">
              <Input
                id="sys-ghClientSecret"
                value={clientSecret}
                disabled
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                onClick={() => {
                  setEditingClientSecret(true);
                  setClientSecret("");
                }}
              >
                Edit
              </Button>
            </div>
          ) : (
            <Input
              id="sys-ghClientSecret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              required
              autoFocus={editingClientSecret}
            />
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-privateKey">Private key (PEM)</Label>
        {isMasked(privateKey) && !editingPrivateKey ? (
          <div className="flex gap-2">
            <Input
              id="sys-privateKey"
              value={privateKey}
              disabled
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="squircle shrink-0"
              onClick={() => {
                setEditingPrivateKey(true);
                setPrivateKey("");
              }}
            >
              Edit
            </Button>
          </div>
        ) : (
          <Textarea
            id="sys-privateKey"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            placeholder="-----BEGIN RSA PRIVATE KEY-----"
            required
            autoFocus={editingPrivateKey}
          />
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="sys-webhookSecret">Webhook secret</Label>
        {isMasked(webhookSecret) && !editingWebhookSecret ? (
          <div className="flex gap-2">
            <Input
              id="sys-webhookSecret"
              value={webhookSecret}
              disabled
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="squircle shrink-0"
              onClick={() => {
                setEditingWebhookSecret(true);
                setWebhookSecret("");
              }}
            >
              Edit
            </Button>
          </div>
        ) : (
          <Input
            id="sys-webhookSecret"
            type="password"
            value={webhookSecret}
            onChange={(e) => setWebhookSecret(e.target.value)}
            required
            autoFocus={editingWebhookSecret}
          />
        )}
      </div>

      <Button type="submit" className="squircle" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Services Settings
// ---------------------------------------------------------------------------

function ServicesSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState(false);
  const [logs, setLogs] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/setup/services");
        if (!res.ok) throw new Error("Failed to fetch");
        const data = await res.json();
        setMetrics(!!data.metrics);
        setLogs(!!data.logs);
      } catch {
        // defaults
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch("/api/setup/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metrics, logs }),
      });
      if (!res.ok) throw new Error("Failed to save");
      toast.success("Services settings saved");
    } catch {
      toast.error("Failed to save services settings");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg">
      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Container metrics</div>
          <div className="text-xs text-muted-foreground">
            cAdvisor — CPU, memory, network stats per container
          </div>
        </div>
        <Switch checked={metrics} onCheckedChange={setMetrics} />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">Persistent logs</div>
          <div className="text-xs text-muted-foreground">
            Loki + Promtail — searchable container logs
          </div>
        </div>
        <Switch checked={logs} onCheckedChange={setLogs} />
      </div>

      <Button type="submit" className="squircle" disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------
// System Settings (combined tabs)
// ---------------------------------------------------------------------------

export function SystemSettings({ defaultTab }: { defaultTab?: string }) {
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">System</h2>
        <p className="text-sm text-muted-foreground">
          Platform-wide configuration. Only visible to app admins.
        </p>
      </div>

      <Tabs defaultValue={defaultTab || "email"}>
        <TabsList variant="line">
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="backup">Backup storage</TabsTrigger>
          <TabsTrigger value="github">GitHub App</TabsTrigger>
          <TabsTrigger value="services">Services</TabsTrigger>
        </TabsList>

        <TabsContent value="email" className="pt-4">
          <EmailSettings />
        </TabsContent>

        <TabsContent value="backup" className="pt-4">
          <BackupSettings />
        </TabsContent>

        <TabsContent value="github" className="pt-4">
          <GitHubSettings />
        </TabsContent>

        <TabsContent value="services" className="pt-4">
          <ServicesSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

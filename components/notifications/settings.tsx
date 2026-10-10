"use client";

import { useState, useCallback, useRef } from "react";
import { DEFAULT_APP_NAME } from "@/lib/app-name";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { useVerify } from "@/hooks/use-verify";
import { Card, CardContent } from "@/components/ui/card";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { useSystemSetting } from "@/app/(authenticated)/admin/settings/use-system-setting";
import {
  ProviderGuide,
  StepList,
  GuideLink,
  CopyableField,
} from "@/components/setup/provider-guide";
import {
  EMAIL_PROVIDER_GUIDES,
  SMTP_PRESETS,
  getPouchWebhookUrl,
} from "@/lib/setup/provider-guides";

/** Convert sentinel-prefixed value to display-friendly mask. */
function toDisplay(value: string): string {
  if (value.startsWith(MASK_SENTINEL)) {
    return `••••${value.slice(MASK_SENTINEL.length)}`;
  }
  return value;
}

function isMaskedValue(value: string): boolean {
  return typeof value === "string" && value.startsWith(MASK_SENTINEL);
}

const API_KEY_LABELS: Record<string, { label: string; placeholder?: string }> = {
  pouch: { label: "Pouch API key" },
  resend: { label: "Resend API key", placeholder: "re_..." },
  postmark: { label: "Postmark server token", placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" },
  mailpace: { label: "Mailpace API token" },
};

/** A stored secret: shown masked with Edit, or as a password input while editing. */
function SecretField({
  id,
  label,
  placeholder,
  value,
  onChange,
  editing,
  onEditingChange,
  onCancel,
  required,
  hint,
}: {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  onCancel: () => void;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {isMaskedValue(value) && !editing ? (
        <div className="flex gap-2">
          <Input id={id} value={toDisplay(value)} disabled className="font-mono" />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            aria-label={`Edit ${label}`}
            onClick={() => {
              onEditingChange(true);
              onChange("");
            }}
          >
            Edit
          </Button>
        </div>
      ) : editing ? (
        <div className="flex gap-2">
          <Input
            id={id}
            type="password"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            required={required}
            autoFocus
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              onEditingChange(false);
              onCancel();
            }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Input
          id={id}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
        />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function EmailSettings() {
  const [provider, setProvider] = useState("resend");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [allowSmtp, setAllowSmtp] = useState(true);
  const [baseUrl, setBaseUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const [editingSmtpPass, setEditingSmtpPass] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);
  const [editingWebhookSecret, setEditingWebhookSecret] = useState(false);

  // Store masked values so Cancel can restore them
  const maskedSmtpPass = useRef("");
  const maskedApiKey = useRef("");
  const maskedWebhookSecret = useRef("");

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setAllowSmtp(data.allowSmtp !== false);
      setProvider((data.provider as string) || "smtp");
      setSmtpHost((data.smtpHost as string) || "");
      setSmtpPort(data.smtpPort?.toString() || "587");
      setSmtpUser((data.smtpUser as string) || "");
      const pass = (data.smtpPass as string) || "";
      const key = (data.apiKey as string) || "";
      setSmtpPass(pass);
      setApiKey(key);
      maskedSmtpPass.current = pass;
      maskedApiKey.current = key;
      setFromEmail((data.fromEmail as string) || "");
      setFromName((data.fromName as string) || "");
      setBaseUrl((data.baseUrl as string) || "");
      const secret = (data.webhookSecret as string) || "";
      setWebhookSecret(secret);
      maskedWebhookSecret.current = secret;
      setEditingSmtpPass(false);
      setEditingApiKey(false);
      setEditingWebhookSecret(false);
    },
    [],
  );

  const { verify, verifying, result: verifyResult, reset: resetVerify } = useVerify("/api/setup/email/verify");

  const { loading, saving, configured, save } = useSystemSetting("/api/setup/email", {
    label: "Email settings",
    onLoad,
    onSaved: () => {
      setEditingSmtpPass(false);
      setEditingApiKey(false);
      setEditingWebhookSecret(false);
      resetVerify();
    },
  });

  // Reset provider-specific fields when the provider changes.
  function handleProviderChange(next: string) {
    if (next !== provider) {
      if (provider === "smtp") {
        setSmtpHost("");
        setSmtpPort("587");
        setSmtpUser("");
        setSmtpPass("");
        setEditingSmtpPass(false);
      } else {
        setApiKey("");
        setEditingApiKey(false);
      }
      if (provider === "pouch") {
        setBaseUrl("");
        setWebhookSecret("");
        setEditingWebhookSecret(false);
      }
    }
    setProvider(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({
      provider,
      smtpHost,
      smtpPort: Number(smtpPort),
      smtpUser,
      smtpPass,
      apiKey,
      fromEmail,
      fromName,
      ...(provider === "pouch" && { baseUrl, webhookSecret }),
    });
  }

  const webhookUrl = typeof window !== "undefined" ? getPouchWebhookUrl(window.location.origin) : "";

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading email settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="type-h2">Email</h2>
        <p className="text-sm text-muted-foreground">
          Configure how your instance sends transactional emails — deploy notifications, invitations and alerts.
        </p>
      </div>

    <Card>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {configured && (
            <p className="text-xs text-muted-foreground">
              Email is configured. Edit fields below to update.
            </p>
          )}

          {!allowSmtp && provider === "smtp" && (
            <Card variant="plain" className="surface-danger border px-3 py-2 text-xs text-destructive">
              SMTP is restricted on this instance. Switch to Pouch, Resend, Postmark or Mailpace to continue sending email.
            </Card>
          )}

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-email-provider">Provider</Label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger id="sys-email-provider" aria-label="Email provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pouch">Pouch</SelectItem>
                <SelectItem value="resend">Resend</SelectItem>
                <SelectItem value="postmark">Postmark</SelectItem>
                <SelectItem value="mailpace">Mailpace</SelectItem>
                {allowSmtp && <SelectItem value="smtp">SMTP</SelectItem>}
              </SelectContent>
            </Select>
          </div>

          {provider !== "smtp" && EMAIL_PROVIDER_GUIDES[provider] && (
            <ProviderGuide
              title={`How to get your ${EMAIL_PROVIDER_GUIDES[provider].name} API key`}
              description={EMAIL_PROVIDER_GUIDES[provider].description}
            >
              <StepList steps={[
                `Sign up or log in at ${EMAIL_PROVIDER_GUIDES[provider].name}`,
                EMAIL_PROVIDER_GUIDES[provider].keyLocation,
                "Paste the key into the field below",
              ]} />
              <div className="flex gap-3">
                <GuideLink href={EMAIL_PROVIDER_GUIDES[provider].signupUrl}>Sign up</GuideLink>
                <GuideLink href={EMAIL_PROVIDER_GUIDES[provider].dashboardUrl}>Dashboard</GuideLink>
              </div>
            </ProviderGuide>
          )}

          {provider === "smtp" && allowSmtp && (
            <>
              <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
                SMTP provides no delivery tracking or bounce detection. If a
                notification fails to send, you won&apos;t know. We recommend
                Pouch, Resend, Postmark or Mailpace for reliable delivery.
              </p>
              <ProviderGuide title="Common SMTP settings">
                <div className="space-y-2">
                  {SMTP_PRESETS.map((preset) => (
                    <div key={preset.label} className="flex items-center justify-between text-xs">
                      <div>
                        <span className="font-medium">{preset.label}</span>
                        <span className="text-muted-foreground ml-2">{preset.host}:{preset.port}</span>
                      </div>
                      <span className="text-muted-foreground">{preset.note}</span>
                    </div>
                  ))}
                </div>
              </ProviderGuide>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2 space-y-2">
                  <Label htmlFor="sys-smtpHost">SMTP host</Label>
                  <Input
                    id="sys-smtpHost"
                    value={smtpHost}
                    onChange={(e) => setSmtpHost(e.target.value)}
                    placeholder="smtp.example.com"
                    autoComplete="url"
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
                  autoComplete="username"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sys-smtpPass">Password</Label>
                {isMaskedValue(smtpPass) && !editingSmtpPass ? (
                  <div className="flex gap-2">
                    <Input
                      id="sys-smtpPass"
                      value={toDisplay(smtpPass)}
                      disabled
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      aria-label="Edit SMTP password"
                      onClick={() => {
                        setEditingSmtpPass(true);
                        setSmtpPass("");
                      }}
                    >
                      Edit
                    </Button>
                  </div>
                ) : editingSmtpPass ? (
                  <div className="flex gap-2">
                    <Input
                      id="sys-smtpPass"
                      type="password"
                      value={smtpPass}
                      onChange={(e) => setSmtpPass(e.target.value)}
                      autoComplete="current-password"
                      required
                      autoFocus
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => {
                        setEditingSmtpPass(false);
                        setSmtpPass(maskedSmtpPass.current);
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Input
                    id="sys-smtpPass"
                    type="password"
                    value={smtpPass}
                    onChange={(e) => setSmtpPass(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                )}
              </div>
            </>
          )}

          {provider !== "smtp" && API_KEY_LABELS[provider] && (
            <SecretField
              id={`sys-${provider}-apiKey`}
              label={API_KEY_LABELS[provider].label}
              placeholder={API_KEY_LABELS[provider].placeholder}
              value={apiKey}
              onChange={setApiKey}
              editing={editingApiKey}
              onEditingChange={setEditingApiKey}
              onCancel={() => setApiKey(maskedApiKey.current)}
              required
            />
          )}

          {provider === "pouch" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="sys-pouch-baseUrl">Base URL</Label>
                <Input
                  id="sys-pouch-baseUrl"
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://pouch.email"
                />
                <p className="text-xs text-muted-foreground">Only for self-hosted Pouch.</p>
              </div>
              {webhookUrl && (
                <CopyableField label="Webhook URL (add it to your key in Pouch)" value={webhookUrl} />
              )}
              <SecretField
                id="sys-pouch-webhookSecret"
                label="Webhook signing secret"
                value={webhookSecret}
                onChange={setWebhookSecret}
                editing={editingWebhookSecret}
                onEditingChange={setEditingWebhookSecret}
                onCancel={() => setWebhookSecret(maskedWebhookSecret.current)}
                hint="Optional. Subscribe the webhook to email.delivered, email.bounced and email.complained."
              />
            </>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label htmlFor="sys-fromEmail">From email</Label>
              <Input
                id="sys-fromEmail"
                type="email"
                value={fromEmail}
                onChange={(e) => setFromEmail(e.target.value)}
                placeholder="noreply@example.com"
                autoComplete="email"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="sys-fromName">From name</Label>
              <Input
                id="sys-fromName"
                value={fromName}
                onChange={(e) => setFromName(e.target.value)}
                placeholder={`Instance name · ${DEFAULT_APP_NAME}`}
              />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={saving || (!allowSmtp && provider === "smtp")} aria-label="Save email settings">
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
            {configured && (
              <Button
                type="button"
                variant="outline"
                disabled={verifying}
                onClick={verify}
                aria-label="Test email connection"
              >
                {verifying && <Loader2 className="size-4 animate-spin" />}
                Test connection
              </Button>
            )}
          </div>
          {verifyResult && (
            <div
              className={`flex items-center gap-2 text-sm ${verifyResult.ok ? "text-status-success" : "text-destructive"}`}
              role="status"
              aria-live="polite"
            >
              {verifyResult.ok ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <XCircle className="size-4 shrink-0" />
              )}
              <span>{verifyResult.message}</span>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
    </div>
  );
}

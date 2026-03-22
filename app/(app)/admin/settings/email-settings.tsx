"use client";

import { useState, useCallback, useRef } from "react";
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
import { Loader2 } from "lucide-react";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { useSystemSetting } from "./use-system-setting";

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

export function EmailSettings() {
  const [provider, setProvider] = useState("smtp");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("587");
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("Vardo");

  const [editingSmtpPass, setEditingSmtpPass] = useState(false);
  const [editingApiKey, setEditingApiKey] = useState(false);

  // Store masked values so Cancel can restore them
  const maskedSmtpPass = useRef("");
  const maskedApiKey = useRef("");

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
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
      setFromName((data.fromName as string) || "Vardo");
      setEditingSmtpPass(false);
      setEditingApiKey(false);
    },
    [],
  );

  const { loading, saving, configured, save } = useSystemSetting("/api/setup/email", {
    label: "Email settings",
    onLoad,
    onSaved: () => {
      setEditingSmtpPass(false);
      setEditingApiKey(false);
    },
  });

  // Finding 11: Reset provider-specific fields when provider changes
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
    });
  }

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
        <h2 className="text-lg font-medium">Email</h2>
        <p className="text-sm text-muted-foreground">
          Configure how your instance sends transactional emails — deploy notifications, invitations, and alerts.
        </p>
      </div>

    <form onSubmit={handleSubmit} className="space-y-4">
      {configured && (
        <p className="text-xs text-muted-foreground">
          Email is configured. Edit fields below to update.
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="sys-email-provider">Provider</Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger id="sys-email-provider" aria-label="Email provider">
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
                  className="squircle shrink-0"
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
                  className="squircle shrink-0"
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

      {provider === "mailpace" && (
        <div className="space-y-2">
          <Label htmlFor="sys-mailpace-apiKey">Mailpace API token</Label>
          {isMaskedValue(apiKey) && !editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-mailpace-apiKey"
                value={toDisplay(apiKey)}
                disabled
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                aria-label="Edit Mailpace API token"
                onClick={() => {
                  setEditingApiKey(true);
                  setApiKey("");
                }}
              >
                Edit
              </Button>
            </div>
          ) : editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-mailpace-apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                onClick={() => {
                  setEditingApiKey(false);
                  setApiKey(maskedApiKey.current);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Input
              id="sys-mailpace-apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              required
            />
          )}
        </div>
      )}

      {provider === "resend" && (
        <div className="space-y-2">
          <Label htmlFor="sys-resend-apiKey">Resend API key</Label>
          {isMaskedValue(apiKey) && !editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-resend-apiKey"
                value={toDisplay(apiKey)}
                disabled
                className="font-mono"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                aria-label="Edit Resend API key"
                onClick={() => {
                  setEditingApiKey(true);
                  setApiKey("");
                }}
              >
                Edit
              </Button>
            </div>
          ) : editingApiKey ? (
            <div className="flex gap-2">
              <Input
                id="sys-resend-apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="re_..."
                required
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="squircle shrink-0"
                onClick={() => {
                  setEditingApiKey(false);
                  setApiKey(maskedApiKey.current);
                }}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Input
              id="sys-resend-apiKey"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="re_..."
              required
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
          />
        </div>
      </div>

      <Button type="submit" className="squircle" disabled={saving} aria-label="Save email settings">
        {saving && <Loader2 className="size-4 animate-spin" />}
        Save
      </Button>
    </form>
    </div>
  );
}

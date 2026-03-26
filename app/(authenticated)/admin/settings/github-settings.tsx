"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { MASK_SENTINEL } from "@/lib/mask-secrets";
import { useSystemSetting } from "./use-system-setting";
import {
  ProviderGuide,
  StepList,
  GuideLink,
  CopyableField,
  FieldHint,
  PermissionList,
} from "@/components/setup/provider-guide";
import { GITHUB_GUIDE, getWebhookUrl } from "@/lib/setup/provider-guides";

function toDisplay(value: string): string {
  if (value.startsWith(MASK_SENTINEL)) {
    return `••••${value.slice(MASK_SENTINEL.length)}`;
  }
  return value;
}

function isMaskedValue(value: string): boolean {
  return typeof value === "string" && value.startsWith(MASK_SENTINEL);
}

export function GitHubSettings() {
  const [appId, setAppId] = useState("");
  const [appSlug, setAppSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");

  const [editingClientSecret, setEditingClientSecret] = useState(false);
  const [editingPrivateKey, setEditingPrivateKey] = useState(false);
  const [editingWebhookSecret, setEditingWebhookSecret] = useState(false);

  const maskedClientSecret = useRef("");
  const maskedPrivateKey = useRef("");
  const maskedWebhookSecret = useRef("");

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setAppId((data.appId as string) || "");
      setAppSlug((data.appSlug as string) || "");
      setClientId((data.clientId as string) || "");
      const cs = (data.clientSecret as string) || "";
      const pk = (data.privateKey as string) || "";
      const ws = (data.webhookSecret as string) || "";
      setClientSecret(cs);
      setPrivateKey(pk);
      setWebhookSecret(ws);
      maskedClientSecret.current = cs;
      maskedPrivateKey.current = pk;
      maskedWebhookSecret.current = ws;
      setEditingClientSecret(false);
      setEditingPrivateKey(false);
      setEditingWebhookSecret(false);
    },
    [],
  );

  const { loading, saving, configured, save } = useSystemSetting("/api/setup/github", {
    label: "GitHub App settings",
    onLoad,
    onSaved: () => {
      setEditingClientSecret(false);
      setEditingPrivateKey(false);
      setEditingWebhookSecret(false);
    },
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({ appId, appSlug, clientId, clientSecret, privateKey, webhookSecret });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading GitHub App settings</span>
      </div>
    );
  }

  const appUrl = typeof window !== "undefined" ? window.location.origin : "";
  const webhookUrl = getWebhookUrl(appUrl);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">GitHub App</h2>
        <p className="text-sm text-muted-foreground">
          Connect a GitHub App to import repositories, manage deploy keys, and trigger automatic deployments on push. Create the app in your GitHub account and paste the credentials below.
        </p>
      </div>

      <ProviderGuide title="How to create a GitHub App">
        <StepList steps={GITHUB_GUIDE.steps} />
        <PermissionList permissions={GITHUB_GUIDE.permissions} />
        <GuideLink href={GITHUB_GUIDE.createAppUrl}>Create GitHub App</GuideLink>
      </ProviderGuide>

      {webhookUrl && (
        <CopyableField label="Webhook URL (paste into GitHub)" value={webhookUrl} />
      )}

    <Card className="squircle rounded-lg">
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          {configured && (
            <p className="text-xs text-muted-foreground">
              GitHub App is configured. Edit fields below to update.
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-md">
            <div className="space-y-2">
              <Label htmlFor="sys-appId">App ID</Label>
              <Input
                id="sys-appId"
                value={appId}
                onChange={(e) => setAppId(e.target.value)}
                required
              />
              <FieldHint>{GITHUB_GUIDE.fieldHints.appId}</FieldHint>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sys-appSlug">App slug</Label>
              <Input
                id="sys-appSlug"
                value={appSlug}
                onChange={(e) => setAppSlug(e.target.value)}
                required
              />
              <FieldHint>{GITHUB_GUIDE.fieldHints.appSlug}</FieldHint>
            </div>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-ghClientId">Client ID</Label>
            <Input
              id="sys-ghClientId"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              required
            />
            <FieldHint>{GITHUB_GUIDE.fieldHints.clientId}</FieldHint>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-ghClientSecret">Client secret</Label>
            {isMaskedValue(clientSecret) && !editingClientSecret ? (
              <div className="flex gap-2">
                <Input
                  id="sys-ghClientSecret"
                  value={toDisplay(clientSecret)}
                  disabled
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Edit client secret"
                  onClick={() => {
                    setEditingClientSecret(true);
                    setClientSecret("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : editingClientSecret ? (
              <div className="flex gap-2">
                <Input
                  id="sys-ghClientSecret"
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
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
                    setEditingClientSecret(false);
                    setClientSecret(maskedClientSecret.current);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Input
                id="sys-ghClientSecret"
                type="password"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sys-privateKey">Private key (PEM)</Label>
            {isMaskedValue(privateKey) && !editingPrivateKey ? (
              <div className="flex gap-2">
                <Input
                  id="sys-privateKey"
                  value={toDisplay(privateKey)}
                  disabled
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Edit private key"
                  onClick={() => {
                    setEditingPrivateKey(true);
                    setPrivateKey("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : editingPrivateKey ? (
              <div className="flex gap-2 items-start">
                <Textarea
                  id="sys-privateKey"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----"
                  required
                  autoFocus
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  onClick={() => {
                    setEditingPrivateKey(false);
                    setPrivateKey(maskedPrivateKey.current);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Textarea
                id="sys-privateKey"
                value={privateKey}
                onChange={(e) => setPrivateKey(e.target.value)}
                placeholder="-----BEGIN RSA PRIVATE KEY-----"
                required
              />
            )}
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-webhookSecret">Webhook secret</Label>
            {isMaskedValue(webhookSecret) && !editingWebhookSecret ? (
              <div className="flex gap-2">
                <Input
                  id="sys-webhookSecret"
                  value={toDisplay(webhookSecret)}
                  disabled
                  className="font-mono"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="squircle shrink-0"
                  aria-label="Edit webhook secret"
                  onClick={() => {
                    setEditingWebhookSecret(true);
                    setWebhookSecret("");
                  }}
                >
                  Edit
                </Button>
              </div>
            ) : editingWebhookSecret ? (
              <div className="flex gap-2">
                <Input
                  id="sys-webhookSecret"
                  type="password"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
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
                    setEditingWebhookSecret(false);
                    setWebhookSecret(maskedWebhookSecret.current);
                  }}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Input
                id="sys-webhookSecret"
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                autoComplete="current-password"
                required
              />
            )}
          </div>

          <Button type="submit" className="squircle" disabled={saving} aria-label="Save GitHub App settings">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
    </div>
  );
}

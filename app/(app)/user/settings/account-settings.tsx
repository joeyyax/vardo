"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  Eye,
  EyeOff,
  Shield,
  ShieldCheck,
  Monitor,
  Trash2,
  Copy,
  Plus,
  Key,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { authClient, useSession } from "@/lib/auth/client";

// ---------------------------------------------------------------------------
// Account Info
// ---------------------------------------------------------------------------

export function AccountInfo() {
  const { data: sessionData, isPending } = useSession();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (sessionData?.user?.name) {
      setName(sessionData.user.name);
    }
  }, [sessionData]);

  async function handleSaveName() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { error } = await authClient.updateUser({ name: name.trim() });
      if (error) {
        toast.error(error.message || "Failed to update name");
      } else {
        toast.success("Name updated");
      }
    } catch {
      toast.error("Failed to update name");
    } finally {
      setSaving(false);
    }
  }

  if (isPending) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Account</h2>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="profile-name">Name</Label>
          <div className="flex gap-2">
            <Input
              id="profile-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() && name !== sessionData?.user?.name) handleSaveName();
              }}
              onKeyDown={(e) => { if (e.key === "Enter") handleSaveName(); }}
            />
            {saving && <Loader2 className="size-4 animate-spin text-muted-foreground mt-2.5" />}
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Email</Label>
          <Input value={sessionData?.user?.email || ""} disabled />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Password Management
// ---------------------------------------------------------------------------

export function PasswordManagement() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match");
      return;
    }
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }

    setSaving(true);
    try {
      const { error } = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: false,
      });
      if (error) {
        toast.error(error.message || "Failed to change password");
      } else {
        toast.success("Password changed");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      }
    } catch {
      toast.error("Failed to change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Password</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Change your account password.
        </p>
      </div>

      <form onSubmit={handleChangePassword} className="space-y-3 max-w-sm">
        <div className="space-y-1.5">
          <Label htmlFor="current-password">Current password</Label>
          <div className="relative">
            <Input
              id="current-password"
              type={showCurrent ? "text" : "password"}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
            />
            <button
              type="button"
              onClick={() => setShowCurrent(!showCurrent)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showCurrent ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="new-password">New password</Label>
          <div className="relative">
            <Input
              id="new-password"
              type={showNew ? "text" : "password"}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
            />
            <button
              type="button"
              onClick={() => setShowNew(!showNew)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showNew ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">Confirm new password</Label>
          <Input
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
            required
          />
        </div>

        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
          Change password
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Two-Factor Authentication
// ---------------------------------------------------------------------------

export function TwoFactorAuth() {
  const { data: sessionData } = useSession();
  const [enabling, setEnabling] = useState(false);
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisable, setShowDisable] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);

  const isEnabled = sessionData?.user?.twoFactorEnabled;

  async function handleEnable() {
    setEnabling(true);
    try {
      const { data, error } = await authClient.twoFactor.enable({
        password: "",
      });
      if (error) {
        toast.error(error.message || "Failed to enable 2FA");
        setEnabling(false);
        return;
      }
      if (data?.totpURI) {
        setTotpUri(data.totpURI);
        if (data.backupCodes) {
          setBackupCodes(data.backupCodes);
        }
      }
    } catch {
      toast.error("Failed to enable 2FA");
    } finally {
      setEnabling(false);
    }
  }

  async function handleVerify() {
    setVerifying(true);
    try {
      const { error } = await authClient.twoFactor.verifyTotp({
        code: verifyCode,
      });
      if (error) {
        toast.error(error.message || "Invalid code");
      } else {
        toast.success("Two-factor authentication enabled");
        setTotpUri(null);
        setVerifyCode("");
      }
    } catch {
      toast.error("Failed to verify code");
    } finally {
      setVerifying(false);
    }
  }

  async function handleDisable() {
    if (!disablePassword) {
      toast.error("Password is required");
      return;
    }
    setDisabling(true);
    try {
      const { error } = await authClient.twoFactor.disable({
        password: disablePassword,
      });
      if (error) {
        toast.error(error.message || "Failed to disable 2FA");
      } else {
        toast.success("Two-factor authentication disabled");
        setShowDisable(false);
        setDisablePassword("");
      }
    } catch {
      toast.error("Failed to disable 2FA");
    } finally {
      setDisabling(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Two-factor authentication</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Add an extra layer of security to your account with TOTP.
        </p>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isEnabled ? (
              <ShieldCheck className="size-5 text-green-500" />
            ) : (
              <Shield className="size-5 text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium">
                {isEnabled ? "Enabled" : "Disabled"}
              </p>
              <p className="text-xs text-muted-foreground">
                {isEnabled
                  ? "Your account is protected with 2FA"
                  : "Enable 2FA for additional security"}
              </p>
            </div>
          </div>

          {isEnabled ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowDisable(!showDisable)}
            >
              Disable
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={handleEnable}
              disabled={enabling}
            >
              {enabling && <Loader2 className="mr-1.5 size-4 animate-spin" />}
              Enable
            </Button>
          )}
        </div>

        {/* TOTP Setup */}
        {totpUri && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with your authenticator app, then enter the code
              below.
            </p>
            <div className="flex justify-center rounded-lg bg-white p-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(totpUri)}`}
                alt="TOTP QR Code"
                width={200}
                height={200}
              />
            </div>
            <div className="flex items-center gap-2 max-w-xs">
              <Input
                placeholder="Enter 6-digit code"
                value={verifyCode}
                onChange={(e) => setVerifyCode(e.target.value)}
                maxLength={6}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleVerify();
                }}
              />
              <Button
                size="sm"
                onClick={handleVerify}
                disabled={verifying || verifyCode.length !== 6}
              >
                {verifying ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Verify"
                )}
              </Button>
            </div>
            {backupCodes && backupCodes.length > 0 && (
              <div className="mt-3 space-y-2">
                <p className="text-sm font-medium">Backup codes</p>
                <p className="text-xs text-muted-foreground">
                  Save these codes in a safe place. You can use them to sign in
                  if you lose access to your authenticator app.
                </p>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-3 font-mono text-sm">
                  {backupCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Disable confirmation */}
        {showDisable && (
          <div className="mt-4 space-y-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              Enter your password to disable two-factor authentication.
            </p>
            <div className="flex items-center gap-2 max-w-xs">
              <Input
                type="password"
                placeholder="Your password"
                value={disablePassword}
                onChange={(e) => setDisablePassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleDisable();
                }}
              />
              <Button
                size="sm"
                variant="destructive"
                onClick={handleDisable}
                disabled={disabling}
              >
                {disabling ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  "Confirm"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active Sessions
// ---------------------------------------------------------------------------

type SessionInfo = {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
  expiresAt: Date;
};

export function ActiveSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { data: sessionData } = useSession();

  const fetchSessions = useCallback(async () => {
    try {
      const { data, error } = await authClient.listSessions();
      if (error) {
        toast.error("Failed to load sessions");
        return;
      }
      if (data) {
        setSessions(data as SessionInfo[]);
      }
    } catch {
      toast.error("Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  async function handleRevoke(token: string) {
    setRevoking(token);
    try {
      const { error } = await authClient.revokeSession({ token });
      if (error) {
        toast.error(error.message || "Failed to revoke session");
      } else {
        toast.success("Session revoked");
        setSessions((prev) => prev.filter((s) => s.token !== token));
      }
    } catch {
      toast.error("Failed to revoke session");
    } finally {
      setRevoking(null);
    }
  }

  function parseUserAgent(ua?: string | null) {
    if (!ua) return "Unknown device";
    if (ua.includes("Chrome")) return "Chrome";
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Safari")) return "Safari";
    if (ua.includes("Edge")) return "Edge";
    return ua.slice(0, 40);
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Active sessions</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Manage your active sessions across devices.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : sessions.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8">
          <Monitor className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No active sessions.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((s) => {
            const isCurrentSession = s.token === sessionData?.session?.token;
            return (
              <div
                key={s.id}
                className="flex items-center justify-between rounded-lg border bg-card p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Monitor className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium truncate">
                        {parseUserAgent(s.userAgent)}
                      </p>
                      {isCurrentSession && (
                        <Badge variant="secondary" className="text-xs">
                          Current
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {s.ipAddress || "Unknown IP"} &middot; Created{" "}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                {!isCurrentSession && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleRevoke(s.token)}
                    disabled={revoking === s.token}
                  >
                    {revoking === s.token ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4 text-destructive" />
                    )}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API Tokens
// ---------------------------------------------------------------------------

type ApiToken = {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
};

export function ApiTokens({ orgId }: { orgId: string }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/tokens`
      );
      if (res.ok) {
        const data = await res.json();
        setTokens(data.tokens || []);
      }
    } catch {
      console.error("Failed to fetch tokens");
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    fetchTokens();
  }, [fetchTokens]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: newTokenName.trim() }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setCreatedToken(data.token);
        setNewTokenName("");
        setShowCreate(false);
        fetchTokens();
        toast.success("Token created");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to create token");
      }
    } catch {
      toast.error("Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/tokens`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        }
      );
      if (res.ok) {
        setTokens((prev) => prev.filter((t) => t.id !== id));
        toast.success("Token deleted");
      } else {
        toast.error("Failed to delete token");
      }
    } catch {
      toast.error("Failed to delete token");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">API tokens</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage API tokens for programmatic access.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShowCreate(!showCreate);
            setCreatedToken(null);
          }}
        >
          <Plus className="mr-1.5 size-4" />
          New token
        </Button>
      </div>

      {/* Created token display */}
      {createdToken && (
        <div className="rounded-lg border border-green-500/30 bg-green-500/5 p-4 space-y-2">
          <p className="text-sm font-medium">
            Token created. Copy it now -- it won't be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
              {createdToken}
            </code>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(createdToken);
                toast.success("Copied to clipboard");
              }}
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="flex items-end gap-2 max-w-sm"
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="token-name">Token name</Label>
            <Input
              id="token-name"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="e.g., CI/CD Pipeline"
              required
              autoFocus
            />
          </div>
          <Button type="submit" size="sm" disabled={creating}>
            {creating && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Create
          </Button>
        </form>
      )}

      {/* Token list */}
      {loading ? (
        <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : tokens.length === 0 && !showCreate ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8">
          <Key className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No API tokens created yet.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {tokens.map((token) => (
            <div
              key={token.id}
              className="flex items-center justify-between rounded-lg border bg-card p-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{token.name}</p>
                <p className="text-xs text-muted-foreground">
                  Created {new Date(token.createdAt).toLocaleDateString()}
                  {token.lastUsedAt &&
                    ` \u00b7 Last used ${new Date(token.lastUsedAt).toLocaleDateString()}`}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleDelete(token.id)}
                disabled={deleting === token.id}
              >
                {deleting === token.id ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4 text-destructive" />
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

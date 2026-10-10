"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { copyToClipboard } from "@/lib/clipboard";
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
  KeyRound,
} from "lucide-react";
import { Github } from "@/components/icons/github";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { CAPABILITIES, type Capability, type TokenScopeKind } from "@/lib/auth/permissions";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RelativeTime } from "@/components/relative-time";
import { authClient, useSession, passkey as passkeyMethods } from "@/lib/auth/client";
import { VERIFIED_CALLBACK } from "@/lib/auth/verify-email-paths";

export function AccountInfo() {
  const { data: sessionData, isPending, refetch } = useSession();
  const sessionName = sessionData?.user?.name ?? "";
  const sessionEmail = sessionData?.user?.email ?? "";
  const verified = sessionData?.user?.emailVerified === true;
  const [name, setName] = useState(sessionName);
  const [syncedName, setSyncedName] = useState(sessionName);
  const [email, setEmail] = useState(sessionEmail);
  const [syncedEmail, setSyncedEmail] = useState(sessionEmail);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  if (sessionName && sessionName !== syncedName) {
    setSyncedName(sessionName);
    setName(sessionName);
  }
  if (sessionEmail && sessionEmail !== syncedEmail) {
    setSyncedEmail(sessionEmail);
    setEmail(sessionEmail);
  }

  // The verification link returns here with a flag.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const failed = params.get("error");
    if (params.get("emailVerified") !== "1" && !failed) return;
    if (failed) toast.error("That verification link is invalid or expired");
    else toast.success("Email verified");
    params.delete("emailVerified");
    params.delete("error");
    const query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
    refetch();
  }, [refetch]);

  async function sendVerification(address: string) {
    const { error } = await authClient.sendVerificationEmail({ email: address, callbackURL: VERIFIED_CALLBACK });
    if (error) throw new Error(error.message || "Couldn't send the verification email");
  }

  async function handleVerify() {
    setSending(true);
    try {
      await sendVerification(sessionEmail);
      toast.success(`Verification email sent to ${sessionEmail}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send the verification email");
    } finally {
      setSending(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const nextEmail = email.trim();
    const nameChanged = name.trim() !== sessionName;
    const emailChanged = nextEmail !== "" && nextEmail.toLowerCase() !== sessionEmail.toLowerCase();
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (nameChanged || !emailChanged) {
        const { error } = await authClient.updateUser({ name: name.trim() });
        if (error) {
          toast.error(error.message || "Couldn't update name");
          return;
        }
        if (!emailChanged) toast.success("Name updated");
      }
      if (emailChanged) {
        const { error } = await authClient.changeEmail({ newEmail: nextEmail, callbackURL: VERIFIED_CALLBACK });
        if (error) {
          toast.error(error.message || "Couldn't change email");
          return;
        }
        toast.success(
          verified
            ? `Verification email sent to ${nextEmail}. Your email changes once you verify it.`
            : `Email changed. Verification email sent to ${nextEmail}.`,
        );
        if (verified) setEmail(sessionEmail);
        refetch();
      }
    } catch {
      toast.error("Couldn't save changes");
    } finally {
      setSaving(false);
    }
  }

  if (isPending) {
    return (
      <Card variant="inset" className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Update your display name and email.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSave} className="space-y-3 max-w-sm">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="profile-email">Email</Label>
              <Input
                id="profile-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {verified ? (
              <Badge variant="secondary">
                <ShieldCheck className="size-3" />
                Email verified
              </Badge>
            ) : (
              <>
                <span>Email not verified.</span>
                <Button type="button" variant="outline" size="sm" onClick={handleVerify} disabled={sending}>
                  {sending && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                  Verify
                </Button>
              </>
            )}
          </div>

          <Button type="submit" size="sm" disabled={saving}>
            {saving && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

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
      toast.error("Passwords don't match");
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
        revokeOtherSessions: true,
      });
      if (error) {
        toast.error(error.message || "Couldn't change password");
      } else {
        toast.success("Password changed");
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
      }
    } catch {
      toast.error("Couldn't change password");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
        <CardDescription>Must be at least 8 characters. Existing sessions stay active.</CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

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
        toast.error(error.message || "Couldn't enable 2FA");
        setEnabling(false);
        return;
      }
      if (data?.method === "totp") {
        setTotpUri(data.totpURI);
        setBackupCodes(data.backupCodes);
      }
    } catch {
      toast.error("Couldn't enable 2FA");
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
      toast.error("Couldn't verify code");
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
        toast.error(error.message || "Couldn't disable 2FA");
      } else {
        toast.success("Two-factor authentication disabled");
        setShowDisable(false);
        setDisablePassword("");
      }
    } catch {
      toast.error("Couldn't disable 2FA");
    } finally {
      setDisabling(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Two-factor authentication</CardTitle>
        <CardDescription>Use an authenticator app like 1Password or Authy for a second factor at login.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isEnabled ? (
              <ShieldCheck className="size-5 text-status-success" />
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
          <Card variant="inset" className="mt-4 space-y-3 p-4">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with your authenticator app, then enter the code
              below.
            </p>
            <div className="flex justify-center rounded-lg bg-white p-4">
              { }
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
                <p className="type-h4">Backup codes</p>
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
          </Card>
        )}

        {/* Disable confirmation */}
        {showDisable && (
          <Card variant="inset" className="mt-4 space-y-3 p-4">
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
          </Card>
        )}
      </CardContent>
    </Card>
  );
}

type PasskeyInfo = {
  id: string;
  name: string | null;
  createdAt: string | Date | null;
};

async function requestPasskeys(): Promise<PasskeyInfo[] | null> {
  try {
    const res = await fetch("/api/auth/passkey/list-user-passkeys");
    if (!res.ok) return null;
    return (await res.json()) as PasskeyInfo[];
  } catch {
    // Passkey list may fail silently on first load
    return null;
  }
}

export function PasskeyManager() {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const applyPasskeys = useCallback((list: PasskeyInfo[] | null) => {
    if (list) setPasskeys(list);
    setLoading(false);
  }, []);

  const fetchPasskeys = useCallback(async () => {
    applyPasskeys(await requestPasskeys());
  }, [applyPasskeys]);

  useEffect(() => {
    requestPasskeys().then(applyPasskeys);
  }, [applyPasskeys]);

  async function handleAdd() {
    setAdding(true);
    try {
      await passkeyMethods.addPasskey({
        name: `Passkey ${passkeys.length + 1}`,
      });
      toast.success("Passkey registered");
      fetchPasskeys();
    } catch {
      toast.error(
        "Passkey registration failed. Your browser may not support passkeys.",
      );
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      await fetch("/api/auth/passkey/delete-passkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
      toast.success("Passkey removed");
    } catch {
      toast.error("Couldn't remove passkey");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Passkeys</CardTitle>
            <CardDescription>
              Register passkeys for fast, secure sign-in. You can have multiple
              passkeys across devices.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleAdd}
            disabled={adding}
          >
            {adding ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-4" />
            )}
            Add passkey
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : passkeys.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8">
            <KeyRound className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No passkeys registered. Add one for instant sign-in.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {passkeys.map((pk) => (
              <Card
                variant="inset"
                key={pk.id}
                className="flex items-center justify-between p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <KeyRound className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {pk.name || "Unnamed passkey"}
                    </p>
                    {pk.createdAt && (
                      <p className="text-xs text-muted-foreground">
                        Added <RelativeTime date={pk.createdAt} />
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(pk.id)}
                  disabled={deleting === pk.id}
                >
                  {deleting === pk.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4 text-destructive" />
                  )}
                </Button>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type LinkedAccount = {
  id: string;
  providerId: string;
  accountId: string;
  createdAt: string;
};

const PROVIDER_LABELS: Record<string, { label: string; icon: typeof Github }> = {
  github: { label: "GitHub", icon: Github },
};

async function requestAccounts(): Promise<LinkedAccount[] | null> {
  try {
    const res = await fetch("/api/auth/list-accounts");
    if (!res.ok) return null;
    const data = await res.json();
    return (data as LinkedAccount[]).filter((a) => a.providerId !== "credential");
  } catch {
    // Silently fail
    return null;
  }
}

export function LinkedAccounts() {
  const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    requestAccounts().then((list) => {
      if (list) setAccounts(list);
      setLoading(false);
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Linked accounts</CardTitle>
            <CardDescription>
              External accounts you can use to sign in.
            </CardDescription>
          </div>
          {!accounts.some((a) => a.providerId === "github") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const url = new URL("/api/auth/sign-in/social", window.location.origin);
                url.searchParams.set("provider", "github");
                url.searchParams.set("callbackURL", window.location.href);
                window.location.assign(url);
              }}
            >
              <Github className="mr-1.5 size-4" />
              Link GitHub
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8">
            <Github className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No linked accounts. Link GitHub for one-click sign-in.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map((acct) => {
              const provider = PROVIDER_LABELS[acct.providerId];
              const Icon = provider?.icon ?? Github;
              return (
                <Card
                  variant="inset"
                  key={acct.id}
                  className="flex items-center justify-between p-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">
                        {provider?.label ?? acct.providerId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Connected <RelativeTime date={acct.createdAt} />
                      </p>
                    </div>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    Connected
                  </Badge>
                </Card>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type SessionInfo = {
  id: string;
  token: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: Date;
  expiresAt: Date;
};

async function requestSessions(): Promise<SessionInfo[] | null> {
  try {
    const { data, error } = await authClient.listSessions();
    if (error) {
      toast.error("Couldn't load sessions");
      return null;
    }
    return data ? (data as SessionInfo[]) : null;
  } catch {
    toast.error("Couldn't load sessions");
    return null;
  }
}

export function ActiveSessions() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const { data: sessionData } = useSession();

  useEffect(() => {
    requestSessions().then((list) => {
      if (list) setSessions(list);
      setLoading(false);
    });
  }, []);

  async function handleRevoke(token: string) {
    setRevoking(token);
    try {
      const { error } = await authClient.revokeSession({ token });
      if (error) {
        toast.error(error.message || "Couldn't revoke session");
      } else {
        toast.success("Session revoked");
        setSessions((prev) => prev.filter((s) => s.token !== token));
      }
    } catch {
      toast.error("Couldn't revoke session");
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
    <Card>
      <CardHeader>
        <CardTitle>Active sessions</CardTitle>
        <CardDescription>Revoke sessions you don&apos;t recognize. Your current session is marked.</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8">
            <Monitor className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No active sessions.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sessions.map((s) => {
              const isCurrentSession = s.token === sessionData?.session?.token;
              return (
                <Card
                  variant="inset"
                  key={s.id}
                  className="flex items-center justify-between p-3"
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
                        <RelativeTime date={s.createdAt} />
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
                </Card>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

type ApiToken = {
  id: string;
  name: string;
  crossOrg: boolean;
  adminAccess: boolean;
  linkedInstances: boolean;
  scope: TokenScopeKind;
  capabilities: Capability[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

const TOKEN_EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "Never" },
];

const TOKEN_SCOPE_OPTIONS: { value: TokenScopeKind; label: string }[] = [
  { value: "full", label: "Full access" },
  { value: "deploy", label: "Deploy" },
  { value: "read", label: "Read-only" },
  { value: "custom", label: "Custom" },
];

const ALL_CAPABILITIES = Object.keys(CAPABILITIES) as Capability[];

function scopeLabel(token: Pick<ApiToken, "scope" | "capabilities">): string {
  if (token.scope === "custom") {
    const n = token.capabilities?.length ?? 0;
    return `${n} ${n === 1 ? "capability" : "capabilities"}`;
  }
  return TOKEN_SCOPE_OPTIONS.find((o) => o.value === token.scope)?.label ?? "No access";
}

function expiryFromOption(option: string): string | null {
  if (option === "never") return null;
  return new Date(Date.now() + Number(option) * 86_400_000).toISOString();
}

async function requestTokens(orgId: string): Promise<ApiToken[] | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/tokens`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.tokens || [];
  } catch {
    console.error("Failed to fetch tokens");
    return null;
  }
}

const ADMIN_SCOPE_WARNING =
  "This token can change instance settings, like email, SSL and auth methods, while you're an instance admin. Give it a short expiry and store it like a root password.";

const LINKED_SCOPE_WARNING =
  "MCP calls through this token can run on linked instances that accept them, as the user with your verified email there, while you're an instance admin here.";

export function ApiTokens({ orgId, canGrantAdmin = false }: { orgId: string; canGrantAdmin?: boolean }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [newTokenExpiry, setNewTokenExpiry] = useState("90");
  const [newTokenScope, setNewTokenScope] = useState<TokenScopeKind>("full");
  const [newTokenCaps, setNewTokenCaps] = useState<Capability[]>([]);
  const [newTokenCrossOrg, setNewTokenCrossOrg] = useState(false);
  const [newTokenAdmin, setNewTokenAdmin] = useState(false);
  const [newTokenLinked, setNewTokenLinked] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const tokenRef = useRef<HTMLElement>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [togglingScope, setTogglingScope] = useState<string | null>(null);
  const [adminTarget, setAdminTarget] = useState<ApiToken | null>(null);
  const [linkedTarget, setLinkedTarget] = useState<ApiToken | null>(null);

  const applyTokens = useCallback((list: ApiToken[] | null) => {
    if (list) setTokens(list);
    setLoading(false);
  }, []);

  const fetchTokens = useCallback(async () => {
    applyTokens(await requestTokens(orgId));
  }, [orgId, applyTokens]);

  useEffect(() => {
    let cancelled = false;
    requestTokens(orgId).then((list) => {
      if (!cancelled) applyTokens(list);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, applyTokens]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTokenName.trim()) return;
    if (newTokenScope === "custom" && newTokenCaps.length === 0) {
      toast.error("Pick at least one capability");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/tokens`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: newTokenName.trim(),
            expiresAt: expiryFromOption(newTokenExpiry),
            scope: newTokenScope,
            crossOrg: newTokenCrossOrg,
            ...(newTokenAdmin && { adminAccess: true }),
            ...(newTokenLinked && { linkedInstances: true }),
            ...(newTokenScope === "custom" && { capabilities: newTokenCaps }),
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setCreatedToken(data.token);
        setNewTokenName("");
        setNewTokenScope("full");
        setNewTokenCaps([]);
        setNewTokenCrossOrg(false);
        setNewTokenAdmin(false);
        setNewTokenLinked(false);
        setShowCreate(false);
        fetchTokens();
        toast.success("Token created");
      } else {
        const data = await res.json();
        toast.error(data.error || "Couldn't create token");
      }
    } catch {
      toast.error("Couldn't create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleScopeChange(
    id: string,
    change: { crossOrg: boolean } | { adminAccess: boolean } | { linkedInstances: boolean },
  ) {
    setTogglingScope(id);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/tokens`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...change }),
      });
      if (res.ok) {
        setTokens((prev) =>
          prev.map((t) => (t.id === id ? { ...t, ...change } : t))
        );
        toast.success("Token scope updated");
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Couldn't update token scope");
      }
    } catch {
      toast.error("Couldn't update token scope");
    } finally {
      setTogglingScope(null);
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
        toast.error("Couldn't delete token");
      }
    } catch {
      toast.error("Couldn't delete token");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>API tokens</CardTitle>
            <CardDescription>Tokens authenticate API requests. Treat them like passwords. A token never does more than your role allows and carries instance-admin access only with the admin scope. Turn on &quot;all my organizations&quot; to let a token act on every organization you belong to.</CardDescription>
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
      </CardHeader>
      <CardContent>
        {/* Created token display */}
        {createdToken && (
          <Card variant="success" className="p-4 space-y-2">
            <p className="text-sm font-medium">
              Token created. Copy it now -- it won&apos;t be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code
                ref={tokenRef}
                className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all select-all"
              >
                {createdToken}
              </code>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy token"
                onClick={async () => {
                  if (await copyToClipboard(createdToken)) {
                    toast.success("Copied to clipboard");
                    return;
                  }
                  const node = tokenRef.current;
                  if (!node) return;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const selection = window.getSelection();
                  selection?.removeAllRanges();
                  selection?.addRange(range);
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </Card>
        )}

        {/* Create form */}
        {showCreate && (
          <form onSubmit={handleCreate} className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1 space-y-1.5">
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
              <div className="space-y-1.5">
                <Label htmlFor="token-expiry">Expires</Label>
                <Select value={newTokenExpiry} onValueChange={setNewTokenExpiry}>
                  <SelectTrigger id="token-expiry" className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOKEN_EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token-scope">Access</Label>
                <Select value={newTokenScope} onValueChange={(v) => setNewTokenScope(v as TokenScopeKind)}>
                  <SelectTrigger id="token-scope" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOKEN_SCOPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="token-orgs">Organizations</Label>
                <Select
                  value={newTokenCrossOrg ? "all" : "this"}
                  onValueChange={(v) => setNewTokenCrossOrg(v === "all")}
                >
                  <SelectTrigger id="token-orgs" className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="this">This organization</SelectItem>
                    <SelectItem value="all">All my organizations</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" size="sm" disabled={creating}>
                {creating && <Loader2 className="mr-1.5 size-4 animate-spin" />}
                Create
              </Button>
            </div>
            {canGrantAdmin && (
              <div className="space-y-2">
                <Label htmlFor="token-admin" className="flex items-center gap-2 text-sm font-normal">
                  <Switch id="token-admin" checked={newTokenAdmin} onCheckedChange={setNewTokenAdmin} />
                  Instance admin scope
                </Label>
                {newTokenAdmin && (
                  <Callout variant="error">{ADMIN_SCOPE_WARNING}</Callout>
                )}
                <Label htmlFor="token-linked" className="flex items-center gap-2 text-sm font-normal">
                  <Switch id="token-linked" checked={newTokenLinked} onCheckedChange={setNewTokenLinked} />
                  Linked instances
                </Label>
                {newTokenLinked && <Callout variant="warning">{LINKED_SCOPE_WARNING}</Callout>}
              </div>
            )}
            {newTokenScope === "custom" && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Capabilities</legend>
                <p className="text-xs text-muted-foreground">Your role still applies.</p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                  {ALL_CAPABILITIES.map((cap) => (
                    <Label key={cap} className="flex items-center gap-2 font-mono text-xs font-normal">
                      <Checkbox
                        checked={newTokenCaps.includes(cap)}
                        onCheckedChange={(checked) =>
                          setNewTokenCaps((prev) =>
                            checked ? [...prev, cap] : prev.filter((c) => c !== cap)
                          )
                        }
                      />
                      {cap}
                    </Label>
                  ))}
                </div>
              </fieldset>
            )}
          </form>
        )}

        {/* Token list */}
        {loading ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : tokens.length === 0 && !showCreate ? (
          <div className="flex flex-col items-center justify-center gap-2 p-8">
            <Key className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No API tokens created yet.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {tokens.map((token) => (
              <Card
                variant="inset"
                key={token.id}
                className="flex items-center justify-between p-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium truncate">{token.name}</p>
                    <Badge
                      variant="outline"
                      className="shrink-0"
                      title={token.scope === "custom" ? token.capabilities?.join(", ") : undefined}
                    >
                      {scopeLabel(token)}
                    </Badge>
                    {token.adminAccess && (
                      <Badge variant="error" className="shrink-0" title={ADMIN_SCOPE_WARNING}>
                        Instance admin
                      </Badge>
                    )}
                    {token.linkedInstances && (
                      <Badge variant="outline" className="shrink-0" title={LINKED_SCOPE_WARNING}>
                        Linked instances
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Created <RelativeTime date={token.createdAt} />
                    {token.expiresAt && (
                      <>
                        {new Date(token.expiresAt) <= new Date() ? " \u00b7 Expired " : " \u00b7 Expires "}
                        <RelativeTime date={token.expiresAt} />
                      </>
                    )}
                    {token.lastUsedAt && (
                      <>
                        {" \u00b7 Last used "}
                        <RelativeTime date={token.lastUsedAt} />
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {(canGrantAdmin || token.adminAccess) && (
                    <Label
                      htmlFor={`admin-${token.id}`}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      Instance admin
                      <Switch
                        id={`admin-${token.id}`}
                        checked={token.adminAccess}
                        disabled={togglingScope === token.id || (!canGrantAdmin && !token.adminAccess)}
                        onCheckedChange={(checked) =>
                          checked ? setAdminTarget(token) : handleScopeChange(token.id, { adminAccess: false })
                        }
                      />
                    </Label>
                  )}
                  {(canGrantAdmin || token.linkedInstances) && (
                    <Label
                      htmlFor={`linked-${token.id}`}
                      className="flex items-center gap-2 text-xs text-muted-foreground"
                    >
                      Linked instances
                      <Switch
                        id={`linked-${token.id}`}
                        checked={token.linkedInstances}
                        disabled={togglingScope === token.id || (!canGrantAdmin && !token.linkedInstances)}
                        onCheckedChange={(checked) =>
                          checked ? setLinkedTarget(token) : handleScopeChange(token.id, { linkedInstances: false })
                        }
                      />
                    </Label>
                  )}
                  <Label
                    htmlFor={`cross-org-${token.id}`}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    All my organizations
                    <Switch
                      id={`cross-org-${token.id}`}
                      checked={token.crossOrg}
                      disabled={togglingScope === token.id}
                      onCheckedChange={(checked) =>
                        handleScopeChange(token.id, { crossOrg: checked })
                      }
                    />
                  </Label>
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
              </Card>
            ))}
          </div>
        )}

        <AlertDialog open={adminTarget !== null} onOpenChange={(open) => !open && setAdminTarget(null)}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Give {adminTarget?.name} the instance admin scope?</AlertDialogTitle>
              <AlertDialogDescription>{ADMIN_SCOPE_WARNING}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (adminTarget) handleScopeChange(adminTarget.id, { adminAccess: true });
                  setAdminTarget(null);
                }}
              >
                Grant admin scope
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog open={linkedTarget !== null} onOpenChange={(open) => !open && setLinkedTarget(null)}>
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>Let {linkedTarget?.name} act on linked instances?</AlertDialogTitle>
              <AlertDialogDescription>{LINKED_SCOPE_WARNING}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (linkedTarget) handleScopeChange(linkedTarget.id, { linkedInstances: true });
                  setLinkedTarget(null);
                }}
              >
                Allow linked instances
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

"use client";

import { useState, useCallback, useEffect } from "react";
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
import { Check, X, Loader2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useSystemSetting } from "./use-system-setting";

type AuthMethodStatus = {
  passkeys: boolean;
  magicLink: boolean;
  github: boolean;
  passwords: boolean;
  twoFactor: boolean;
};

export function AuthSettings() {
  const [registrationMode, setRegistrationMode] = useState<string>("closed");
  const [sessionDurationDays, setSessionDurationDays] = useState("7");
  const [authMethods, setAuthMethods] = useState<AuthMethodStatus | null>(null);

  const onLoad = useCallback(
    (data: Record<string, unknown>) => {
      setRegistrationMode((data.registrationMode as string) || "closed");
      setSessionDurationDays(data.sessionDurationDays?.toString() || "7");
    },
    [],
  );

  const { loading, saving, save } = useSystemSetting("/api/setup/auth", {
    label: "Authentication settings",
    onLoad,
  });

  // Fetch auth method status from the health endpoint
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/health");
        if (!res.ok) return;
        const data = await res.json();
        if (data.auth) setAuthMethods(data.auth);
      } catch {
        // best effort
      }
    })();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await save({
      registrationMode,
      sessionDurationDays: Number(sessionDurationDays),
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading authentication settings</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Authentication</h2>
        <p className="text-sm text-muted-foreground">
          Control who can sign up and how sessions work.
        </p>
      </div>

    <Card className="squircle rounded-lg">
      <CardHeader>
        <CardTitle className="text-sm">Settings</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-registration-mode">Registration mode</Label>
            <Select value={registrationMode} onValueChange={setRegistrationMode}>
              <SelectTrigger id="sys-registration-mode" aria-label="Registration mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="closed">Closed (invite only)</SelectItem>
                <SelectItem value="open">Open (anyone can register)</SelectItem>
                <SelectItem value="approval">Approval (requires admin approval)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {registrationMode === "closed" && "New users can only be added by an admin."}
              {registrationMode === "open" && "Anyone with the link can create an account."}
              {registrationMode === "approval" && "New signups are held for admin approval before access is granted."}
            </p>
          </div>

          <div className="max-w-md space-y-2">
            <Label htmlFor="sys-session-duration">Session duration (days)</Label>
            <Input
              id="sys-session-duration"
              type="number"
              min={1}
              max={365}
              value={sessionDurationDays}
              onChange={(e) => setSessionDurationDays(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">
              How long a user stays logged in before needing to re-authenticate.
            </p>
          </div>

          <Button type="submit" className="squircle" disabled={saving} aria-label="Save authentication settings">
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card className="squircle rounded-lg">
      <CardHeader>
        <CardTitle className="text-sm">Authentication methods</CardTitle>
        <CardDescription>
          Configured methods are determined by environment variables and provider setup.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {authMethods ? (
          <div className="flex flex-wrap gap-2">
            {([
              { label: "Password auth", enabled: authMethods.passwords },
              { label: "GitHub OAuth", enabled: authMethods.github },
              { label: "Magic link", enabled: authMethods.magicLink },
              { label: "Passkeys", enabled: authMethods.passkeys },
              { label: "2FA", enabled: authMethods.twoFactor },
            ]).map(({ label, enabled }) => (
              <div
                key={label}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium ${
                  enabled ? "bg-status-success-muted text-status-success" : "bg-muted text-muted-foreground"
                }`}
              >
                {enabled ? <Check className="size-3" /> : <X className="size-3" />}
                {label}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-6 w-20 bg-muted rounded animate-pulse" />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}

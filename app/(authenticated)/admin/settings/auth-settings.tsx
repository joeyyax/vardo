"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Lock } from "lucide-react";
import { toast } from "@/lib/messenger";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useSystemSetting } from "./use-system-setting";

export function AuthSettings() {
  const [registrationMode, setRegistrationMode] = useState<string>("closed");
  const [sessionDurationDays, setSessionDurationDays] = useState("7");

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
          Control who can sign up, how they sign in and how sessions work.
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

    <SignInMethods />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sign-in methods
// ---------------------------------------------------------------------------

type MethodState = {
  method: string;
  label: string;
  description: string;
  enabled: boolean;
  source: "env" | "config" | "database" | "default";
  locked: boolean;
  envVar: string;
  unavailable: boolean;
  unavailableReason?: string;
};

function pinnedBy(m: MethodState) {
  return m.source === "env" ? m.envVar : "vardo.yml";
}

function SignInMethods() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [methods, setMethods] = useState<MethodState[]>([]);
  const [pending, setPending] = useState<Record<string, boolean>>({});

  // Per-method write counter, so rapid flips settle on what was clicked last.
  const writeSeq = useRef<Record<string, number>>({});

  const fetchMethods = useCallback(async () => {
    const res = await fetch("/api/setup/auth-methods");
    if (!res.ok) throw new Error("Failed to fetch");
    const data = await res.json();
    setMethods(data.methods ?? []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        await fetchMethods();
      } catch {
        toast.error("Couldn't load sign-in methods");
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchMethods]);

  async function handleToggle(method: MethodState, next: boolean) {
    if (method.locked || method.unavailable) return;

    const seq = (writeSeq.current[method.method] ?? 0) + 1;
    writeSeq.current[method.method] = seq;

    setMethods((prev) => prev.map((m) => (m.method === method.method ? { ...m, enabled: next } : m)));
    setPending((prev) => ({ ...prev, [method.method]: true }));

    let ok = false;
    let message = "";
    try {
      const res = await fetch("/api/setup/auth-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [method.method]: next }),
      });
      const data = await res.json().catch(() => null);
      ok = res.ok;
      message = data?.error ?? "Couldn't save that change";
    } catch {
      message = "Couldn't reach the server";
    }

    if (writeSeq.current[method.method] !== seq) return;

    setPending((prev) => {
      const rest = { ...prev };
      delete rest[method.method];
      return rest;
    });

    if (ok) {
      toast.success(`${method.label} ${next ? "enabled" : "disabled"}`);
      router.refresh();
      return;
    }

    toast.error(message);
    await fetchMethods().catch(() => {
      setMethods((prev) => prev.map((m) => (m.method === method.method ? { ...m, enabled: !next } : m)));
    });
  }

  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">Sign-in methods</h3>
        <p className="text-xs text-muted-foreground">
          Changes save as you flip them and take effect immediately — a disabled method is refused at
          the API, not just hidden. At least one has to stay usable. A method set in vardo.yml or by a{" "}
          <code className="bg-muted rounded px-1 py-0.5 text-xs">VARDO_AUTH_*</code> env var is shown
          here but can only be changed there.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="sr-only">Loading sign-in methods</span>
        </div>
      ) : (
        <div className="squircle divide-y rounded-lg bg-card shadow-card dark:border">
          {methods.map((m) => (
            <div key={m.method} className="flex items-start justify-between gap-4 p-4">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor={`auth-method-${m.method}`} className="text-sm font-medium">
                    {m.label}
                  </Label>
                  <Badge
                    variant={m.enabled && !m.unavailable ? "default" : "outline"}
                    className={m.enabled && !m.unavailable ? "" : "text-muted-foreground"}
                  >
                    {m.unavailable ? "Unavailable" : m.enabled ? "On" : "Off"}
                  </Badge>
                  {m.locked && (
                    <Badge variant="outline" className="gap-1 text-muted-foreground">
                      <Lock className="size-3" />
                      {pinnedBy(m)}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{m.description}</div>
                {m.unavailable && m.unavailableReason && (
                  <div className="text-xs text-muted-foreground">{m.unavailableReason}</div>
                )}
                {m.locked && (
                  <div className="text-xs text-muted-foreground">
                    Pinned by {pinnedBy(m)} — change it there, then restart.
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {pending[m.method] && (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
                )}
                <Switch
                  id={`auth-method-${m.method}`}
                  checked={m.enabled && !m.unavailable}
                  disabled={m.locked || m.unavailable || !!pending[m.method]}
                  onCheckedChange={(next) => handleToggle(m, next)}
                  aria-label={`${m.enabled ? "Disable" : "Enable"} ${m.label}`}
                  aria-describedby={m.locked ? `auth-method-${m.method}-pinned` : undefined}
                />
                {m.locked && (
                  <span id={`auth-method-${m.method}-pinned`} className="sr-only">
                    Pinned by {pinnedBy(m)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

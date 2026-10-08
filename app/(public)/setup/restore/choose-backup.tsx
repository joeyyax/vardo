"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatBytes } from "@/lib/metrics/format";
import { cn } from "@/lib/utils";

type TargetType = "r2" | "s3" | "b2" | "local";

type FoundBackup = { key: string; takenAt: string; sizeBytes: number };

type KeyCheck =
  | { kind: "match"; keyId: string }
  | { kind: "unencrypted"; keyId: string }
  | { kind: "wrong-key"; archiveKeyId: string; enteredKeyId: string }
  | { kind: "not-loaded"; keyId: string; runningKeyId: string | null };

type BackupCheck = { key: KeyCheck; authSecret: { kind: "none" | "match" | "mismatch" } | null };

const TYPE_LABELS: Record<TargetType, string> = {
  r2: "Cloudflare R2",
  s3: "Amazon S3 or compatible",
  b2: "Backblaze B2",
  local: "Folder on this host",
};

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Something went wrong. Try again.");
  return data as T;
}

export function formatTakenAt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Storage, then the backup, then the key. Nothing is restored until the Key ID matches. */
export function ChooseBackup({
  configuredTarget,
  onStarted,
}: {
  configuredTarget: string | null;
  onStarted: () => void;
}) {
  const [useConfigured, setUseConfigured] = useState(configuredTarget !== null);
  const [type, setType] = useState<TargetType>("r2");
  const [fields, setFields] = useState({ bucket: "", region: "auto", endpoint: "", accessKeyId: "", secretAccessKey: "", path: "" });
  const [backups, setBackups] = useState<FoundBackup[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [masterKey, setMasterKey] = useState("");
  const [check, setCheck] = useState<BackupCheck | null>(null);
  const [hostKey, setHostKey] = useState(false);
  const [busy, setBusy] = useState<"list" | "check" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const target = useConfigured
    ? undefined
    : type === "local"
      ? { type, config: { path: fields.path } }
      : {
          type,
          config: {
            bucket: fields.bucket,
            region: fields.region || "auto",
            accessKeyId: fields.accessKeyId,
            secretAccessKey: fields.secretAccessKey,
            ...(fields.endpoint ? { endpoint: fields.endpoint } : {}),
          },
        };

  async function run<T>(step: "list" | "check" | "start", fn: () => Promise<T>): Promise<T | null> {
    setBusy(step);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function findBackups() {
    setPicked(null);
    setCheck(null);
    setHostKey(false);
    const result = await run("list", () => post<{ backups: FoundBackup[] }>("/api/setup/restore/backups", { target }));
    if (result) setBackups(result.backups);
  }

  async function checkKey() {
    if (!picked) return;
    const result = await run("check", () =>
      post<BackupCheck>("/api/setup/restore/check", { target, backupKey: picked, masterKey }),
    );
    setCheck(result);
  }

  // After install.sh --restore the host holds the key; when its Key ID matches the backup there is nothing to enter.
  async function pick(backupKey: string) {
    setPicked(backupKey);
    setCheck(null);
    setHostKey(false);
    try {
      const result = await post<BackupCheck>("/api/setup/restore/check", { target, backupKey });
      if (result.key.kind === "match") {
        setCheck(result);
        setHostKey(true);
      }
    } catch {
      // Without a usable host key the field below stays.
    }
  }

  async function start() {
    if (!picked) return;
    const result = await run("start", () =>
      post<{ runId: string }>("/api/setup/restore/start", {
        target,
        backupKey: picked,
        ...(hostKey ? {} : { masterKey }),
      }),
    );
    if (result) onStarted();
  }

  const set = (key: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const keyReady =
    (check?.key.kind === "match" || check?.key.kind === "unencrypted") && check.authSecret?.kind !== "mismatch";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-medium">1. Backup storage</h2>
          <CardDescription>Where the old instance wrote its backups.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {useConfigured && configuredTarget ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm">
                {configuredTarget} <span className="text-muted-foreground">(set at install)</span>
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => { setUseConfigured(false); setBackups(null); }}>
                  Use other storage
                </Button>
                <Button size="sm" onClick={findBackups} disabled={busy !== null}>
                  {busy === "list" && <Loader2 className="animate-spin" />}
                  Find backups
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                findBackups();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="restore-type">Storage type</Label>
                <Select value={type} onValueChange={(v) => setType(v as TargetType)}>
                  <SelectTrigger id="restore-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_LABELS) as TargetType[]).map((t) => (
                      <SelectItem key={t} value={t}>
                        {TYPE_LABELS[t]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {type === "local" ? (
                <Field id="restore-path" label="Folder" autoFocus value={fields.path} onChange={set("path")} placeholder="/opt/vardo/backups" />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="restore-bucket" label="Bucket" autoFocus value={fields.bucket} onChange={set("bucket")} />
                  <Field id="restore-region" label="Region" value={fields.region} onChange={set("region")} />
                  <div className="sm:col-span-2">
                    <Field
                      id="restore-endpoint"
                      label="Endpoint (optional)"
                      value={fields.endpoint}
                      onChange={set("endpoint")}
                      placeholder="https://<account>.r2.cloudflarestorage.com"
                      required={false}
                    />
                  </div>
                  <Field id="restore-access" label="Access key ID" value={fields.accessKeyId} onChange={set("accessKeyId")} />
                  <Field
                    id="restore-secret"
                    label="Secret access key"
                    type="password"
                    value={fields.secretAccessKey}
                    onChange={set("secretAccessKey")}
                  />
                </div>
              )}
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {configuredTarget && (
                  <Button type="button" variant="ghost" onClick={() => { setUseConfigured(true); setBackups(null); }}>
                    Use storage from install
                  </Button>
                )}
                <Button type="submit" disabled={busy !== null}>
                  {busy === "list" && <Loader2 className="animate-spin" />}
                  Find backups
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {backups && (
        <Card>
          <CardHeader>
            <h2 className="font-medium">2. Pick a backup</h2>
            <CardDescription>
              Vardo&apos;s database comes back as of this backup. Each app restores its newest archive at or before it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {backups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No system backups in this storage.</p>
            ) : (
              <ul className="divide-y rounded-lg border" role="radiogroup" aria-label="System backups">
                {backups.map((b) => (
                  <li key={b.key}>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={picked === b.key}
                      onClick={() => pick(b.key)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm transition-colors hover:bg-accent",
                        picked === b.key && "bg-accent",
                      )}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "flex size-4 items-center justify-center rounded-full border",
                            picked === b.key && "border-primary bg-primary text-primary-foreground",
                          )}
                        >
                          {picked === b.key && <Check className="size-3" />}
                        </span>
                        {formatTakenAt(b.takenAt)}
                      </span>
                      <span className="tabular-nums text-muted-foreground">{formatBytes(b.sizeBytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {picked && (
        <Card>
          <CardHeader>
            <h2 className="font-medium">3. Master key</h2>
            <CardDescription>
              The ENCRYPTION_MASTER_KEY you escrowed from the old instance. Its Key ID has to match the backup&apos;s.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {hostKey && check ? (
              <KeyCheckResult check={check.key} hostKey />
            ) : (
            <form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault();
                checkKey();
              }}
            >
              <Label htmlFor="restore-key" className="sr-only">
                Master key
              </Label>
              <Input
                id="restore-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="64 hex characters"
                value={masterKey}
                onChange={(e) => { setMasterKey(e.target.value); setCheck(null); }}
                required
              />
              <Button type="submit" variant="outline" disabled={busy !== null || masterKey.trim().length === 0}>
                {busy === "check" && <Loader2 className="animate-spin" />}
                Check Key ID
              </Button>
            </form>
            )}
            {check && !hostKey && <KeyCheckResult check={check.key} />}
            {check?.authSecret?.kind === "mismatch" && (
              <Callout variant="warning" label="Load the auth secret first">
                Two-factor secrets in this backup don&apos;t open with this instance&apos;s BETTER_AUTH_SECRET. On the
                host, run <code className="font-mono">sudo vardo key set</code>, paste both escrowed values, then
                reload this page.
              </Callout>
            )}
            {keyReady && (
              <div className="flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">
                  This replaces this instance&apos;s database. Backups and cron jobs stay paused until you resume them.
                </p>
                <Button onClick={start} disabled={busy !== null}>
                  {busy === "start" && <Loader2 className="animate-spin" />}
                  Restore this backup
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {error && <Callout variant="error">{error}</Callout>}
    </div>
  );
}

function Field({
  id,
  label,
  required = true,
  ...props
}: { id: string; label: string; required?: boolean } & React.ComponentProps<typeof Input>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} required={required} autoComplete="off" {...props} />
    </div>
  );
}

function KeyCheckResult({ check, hostKey = false }: { check: KeyCheck; hostKey?: boolean }) {
  switch (check.kind) {
    case "match":
      return (
        <Callout variant="success" label="Key ID matches">
          The backup was written with Key ID <code className="font-mono">{check.keyId}</code>, {hostKey ? "the key this host already holds" : "the key you entered"}.
        </Callout>
      );
    case "unencrypted":
      return (
        <Callout variant="warning" label="Unencrypted backup">
          This backup predates archive encryption, so it carries no Key ID. Env vars decrypt only if{" "}
          <code className="font-mono">{check.keyId}</code> is the key the old instance used.
        </Callout>
      );
    case "wrong-key":
      return (
        <Callout variant="error" label="Wrong key">
          The backup was written with Key ID <code className="font-mono">{check.archiveKeyId}</code>, and the key you
          entered is <code className="font-mono">{check.enteredKeyId}</code>. Find the key escrowed for that Key ID.
        </Callout>
      );
    case "not-loaded":
      return (
        <Callout variant="warning" label="Load this key first">
          The key matches the backup, but this instance started with Key ID{" "}
          <code className="font-mono">{check.runningKeyId ?? "none"}</code>. On the host, run{" "}
          <code className="font-mono">sudo vardo key set</code>, paste the escrowed values, then reload this page.
        </Callout>
      );
  }
}

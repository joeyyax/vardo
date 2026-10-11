"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import type { AllowEntry } from "@/lib/probe-guard/allowlist";

export const ALLOWLIST_ENDPOINT = "/api/v1/admin/probe-guard/allowlist";

async function fetchEntries(): Promise<AllowEntry[] | null> {
  const res = await fetch(ALLOWLIST_ENDPOINT).catch(() => null);
  return res?.ok ? ((await res.json()) as { entries: AllowEntry[] }).entries : null;
}

/** The never-ban list. `version` reloads it after a ban row's Allow. */
export function AllowlistCard({ version, onChange }: { version: number; onChange: () => void }) {
  const [entries, setEntries] = useState<AllowEntry[] | null>(null);
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [skipGuard, setSkipGuard] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const entries = await fetchEntries();
    if (entries) setEntries(entries);
  }, []);

  useEffect(() => {
    fetchEntries().then((e) => e && setEntries(e));
  }, [version]);

  async function request(key: string, url: string, init: RequestInit, failed: string): Promise<Record<string, unknown> | null> {
    setBusy(key);
    try {
      const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? failed);
        return null;
      }
      await load();
      onChange();
      return body ?? {};
    } catch {
      toast.error(failed);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const body = await request("add", ALLOWLIST_ENDPOINT, { method: "POST", body: JSON.stringify({ value, note, skipGuard }) }, "Couldn't add the address");
    if (!body) return;
    const lifted = Number(body.lifted) || 0;
    toast.success(lifted ? `Added. Lifted ${lifted} ban${lifted === 1 ? "" : "s"}.` : "Added");
    setValue("");
    setNote("");
    setSkipGuard(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Never ban</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Addresses here are never banned, reported or blocked by a blocklist. Probes from them still get the guard&apos;s answers but never count.
        </p>

        {entries === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No addresses yet.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-2">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-mono text-sm">{entry.value}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.note ? `${entry.note} · ` : ""}added <RelativeTime date={entry.addedAt} />
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Label htmlFor={`skip-${entry.id}`} className="text-xs font-normal text-muted-foreground">
                    Skip the probe guard entirely
                  </Label>
                  <Switch
                    id={`skip-${entry.id}`}
                    checked={entry.skipGuard}
                    disabled={busy === entry.id}
                    onCheckedChange={(v) =>
                      void request(entry.id, `${ALLOWLIST_ENDPOINT}/${entry.id}`, { method: "PATCH", body: JSON.stringify({ skipGuard: v }) }, "Couldn't change the entry")
                    }
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Remove ${entry.value}`}
                    disabled={busy === entry.id}
                    onClick={() => void request(entry.id, `${ALLOWLIST_ENDPOINT}/${entry.id}`, { method: "DELETE" }, "Couldn't remove the entry")}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="space-y-3">
          <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="allow-value">IP or CIDR</Label>
              <Input id="allow-value" value={value} placeholder="203.0.113.7 or 198.51.100.0/24" className="font-mono" onChange={(e) => setValue(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="allow-note">Note</Label>
              <Input id="allow-note" value={note} placeholder="Optional" maxLength={200} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <div className="flex items-start justify-between gap-4 sm:max-w-2xl">
            <div className="grid max-w-prose gap-0.5">
              <Label htmlFor="allow-skip">Skip the probe guard entirely</Label>
              <p className="text-xs text-muted-foreground">For your own scanner or a pentester. Their probes reach the app instead of the guard.</p>
            </div>
            <Switch id="allow-skip" checked={skipGuard} onCheckedChange={setSkipGuard} />
          </div>
          <Button type="submit" variant="outline" disabled={busy === "add" || !value.trim()}>
            {busy === "add" && <Loader2 className="size-4 animate-spin" />}
            Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

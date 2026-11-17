"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { toast } from "@/lib/messenger";
import { useCan } from "@/components/capabilities-provider";

type Secret = { name: string; updatedAt: string };

async function fetchSecrets(base: string): Promise<Secret[]> {
  const res = await fetch(base).catch(() => null);
  return res?.ok ? (await res.json()).buildSecrets : [];
}

export function OrgBuildSecrets({ orgId }: { orgId: string }) {
  const canManage = useCan()("org.buildSecrets.manage");
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/v1/organizations/${orgId}/build-secrets`;

  const load = async () => setSecrets(await fetchSecrets(base));

  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    fetchSecrets(base).then((rows) => {
      if (!cancelled) setSecrets(rows);
    });
    return () => { cancelled = true; };
  }, [canManage, base]);

  if (!canManage) return null;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        toast.error((await res.json().catch(() => null))?.error ?? "Couldn't save");
        return;
      }
      toast.success(`Build secret ${name} saved`);
      setName("");
      setValue("");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!removing) return;
    setBusy(true);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(removing)}`, { method: "DELETE" });
      if (!res.ok) toast.error("Couldn't remove");
      else toast.success(`Build secret ${removing} removed`);
      setRemoving(null);
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build secrets</CardTitle>
        <CardDescription>
          Mounted in Dockerfile builds with <code className="bg-muted px-1 py-0.5 rounded">RUN --mount=type=secret,id=NAME</code>. Values are write-only. <code className="bg-muted px-1 py-0.5 rounded">npm_token</code> replaces the GitHub App token.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {secrets === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : secrets.length > 0 ? (
          <ul className="divide-y rounded-md border">
            {secrets.map((s) => (
              <li key={s.name} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="font-mono text-sm">{s.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">Set {new Date(s.updatedAt).toLocaleDateString()}</span>
                <Button size="icon" variant="ghost" aria-label={`Remove ${s.name}`} onClick={() => setRemoving(s.name)}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No build secrets.</p>
        )}

        <form onSubmit={save} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="space-y-1 sm:w-48">
            <Label htmlFor="build-secret-name">Name</Label>
            <Input id="build-secret-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="npm_token" pattern="[a-z][a-z0-9_]*" autoComplete="off" required />
          </div>
          <div className="flex-1 space-y-1">
            <Label htmlFor="build-secret-value">Value</Label>
            <Input id="build-secret-value" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" required />
          </div>
          <Button type="submit" disabled={saving || !name || !value}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </form>
      </CardContent>

      <ConfirmDeleteDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing ?? ""}?`}
        description="The next deploy builds without it. Removing npm_token falls back to the GitHub App token."
        onConfirm={remove}
        loading={busy}
        confirmLabel="Remove"
        loadingLabel="Removing..."
      />
    </Card>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/messenger";

const ENDPOINT = "/api/v1/admin/bind-mounts";

type BindMounts = { roots: string[]; allowed: string[] };

async function fetchData(): Promise<BindMounts | null> {
  const res = await fetch(ENDPOINT).catch(() => null);
  return res?.ok ? ((await res.json()) as BindMounts) : null;
}

/** Host roots untrusted apps may bind-mount from. Set ENCRYPTION_MASTER_KEY first. */
export function BindMountsCard() {
  const [data, setData] = useState<BindMounts | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await fetchData();
    if (next) setData(next);
  }, []);

  useEffect(() => {
    fetchData().then((d) => d && setData(d));
  }, []);

  const allow = async () => {
    const path = input.trim();
    if (!path) return;
    setBusy(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const body = (await res.json().catch(() => null)) as { allowed?: string[]; error?: string } | null;
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't allow the path");
        return;
      }
      toast.success(`Allowed ${path}`);
      setInput("");
      await load();
    } catch {
      toast.error("Couldn't allow the path");
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <Card id="bind-mounts" variant="surface">
        <CardContent className="py-6 flex justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card id="bind-mounts" variant="surface">
      <CardHeader>
        <div className="space-y-1">
          <CardTitle>Bind-mount host paths</CardTitle>
          <p className="text-xs text-muted-foreground">Untrusted apps may mount these host paths. Allowing one here applies to every app.</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.allowed.length === 0 ? (
          <p className="text-xs text-muted-foreground">No host paths allowed yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.allowed.map((path) => (
              <li key={path} className="flex items-center justify-between gap-3 px-3 py-1.5">
                <p className="font-mono text-xs">{path}</p>
                <span className="text-[11px] text-muted-foreground">allowed</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Host path"
            placeholder="/srv/data"
            className="font-mono flex-1 min-w-[200px]"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void allow();
              }
            }}
          />
          <Button size="sm" type="button" disabled={busy || !input.trim()} onClick={() => void allow()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-3.5" />}
            Allow
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Default roots: {data.roots.join(", ") || "none"}.</p>
      </CardContent>
    </Card>
  );
}
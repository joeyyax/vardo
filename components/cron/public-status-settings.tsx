"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "@/components/entity-link";

type StatusPage = { enabled: boolean; token: string | null; hostname: string | null; canSetHostname: boolean };

function UrlRow({ label, url }: { label: string; url: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1.5">
        <a href={url} target="_blank" rel="noreferrer" className="min-w-0 truncate font-mono text-xs hover:underline">
          {url}
        </a>
        <CopyButton value={url} label={`Copy ${label.toLowerCase()}`} />
      </div>
    </div>
  );
}

/** Opt-in public page of cron health: counts and ages, never job names or targets. */
export function PublicStatusSettings({ orgId }: { orgId: string }) {
  const url = `/api/v1/organizations/${orgId}/cron/status-page`;
  const [page, setPage] = useState<StatusPage | null>(null);
  const [hostname, setHostname] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: StatusPage | null) => {
        if (cancelled || !data) return;
        setPage(data);
        setHostname(data.hostname ?? "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  async function save(body: Record<string, unknown>, success: string) {
    setSaving(true);
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error("Couldn't save the status page", { description: data.error });
        return;
      }
      setPage(data);
      setHostname(data.hostname ?? "");
      if (data.routed === false) toast.error("Saved, but the hostname route wasn't written", { description: "Check the console logs" });
      else toast.success(success);
    } catch {
      toast.error("Couldn't save the status page", { description: "Check your connection and try again" });
    } finally {
      setSaving(false);
    }
  }

  if (!page) return null;

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const pageUrl = page.token ? `${origin}/status/cron/${page.token}` : null;
  const jsonUrl = page.token ? `${origin}/api/status/cron/${page.token}` : null;

  return (
    <section className="grid grid-cols-1 gap-3">
      <div>
        <h2 className="type-h3">Public status</h2>
        <p className="text-sm text-muted-foreground">
          A page and JSON anyone with the link can read: job counts, health and last-run ages. No names, URLs or logs.
        </p>
      </div>
      <Card variant="surface" className="grid gap-4 p-4">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={page.enabled}
            disabled={saving}
            onCheckedChange={(enabled) => save({ enabled }, enabled ? "Status page on" : "Status page off")}
          />
          {page.enabled ? "On" : "Off"}
        </label>

        {page.enabled && pageUrl && jsonUrl && (
          <>
            <UrlRow label="Page" url={pageUrl} />
            <UrlRow label="JSON" url={jsonUrl} />
            {page.hostname && (
              <>
                <UrlRow label="Page on its host" url={`https://${page.hostname}/`} />
                <UrlRow label="JSON on its host" url={`https://${page.hostname}/status.json`} />
              </>
            )}
          </>
        )}

        {page.canSetHostname && (
          <form
            className="grid gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              save({ hostname: hostname.trim() || null }, hostname.trim() ? "Hostname saved" : "Hostname removed");
            }}
          >
            <Label htmlFor="cron-status-host">Hostname</Label>
            <div className="flex gap-2">
              <Input
                id="cron-status-host"
                placeholder="cron.example.com"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                className="font-mono text-xs"
              />
              <Button type="submit" variant="outline" disabled={saving || hostname.trim() === (page.hostname ?? "")}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Point its DNS at this server. Vardo routes it and gets the certificate.</p>
          </form>
        )}

        {page.token && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              disabled={saving}
              onClick={() => save({ rotate: true }, "New link made")}
              className="-ml-2 text-muted-foreground"
            >
              New link
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

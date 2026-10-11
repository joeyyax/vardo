"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BansList, type BanItem } from "@/components/probe-guard/bans-list";
import { toast } from "@/lib/messenger";
import { guardSummary, type GuardStatsView } from "@/lib/probe-guard/summary";
import type { AppProbeGuard } from "@/lib/probe-guard/settings";

type GuardData = {
  settings: AppProbeGuard;
  wordpressDetected: boolean;
  available: boolean;
  traps: string[];
  canBanPermanently: boolean;
  stats: GuardStatsView;
  bans: BanItem[];
};

function parseLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function requestGuard(url: string): Promise<GuardData | null> {
  const res = await fetch(url).catch(() => null);
  return res?.ok ? ((await res.json()) as GuardData) : null;
}

/** The app's probe guard: on/off, WordPress handling, exceptions, robots.txt and active bans. */
export function ProbeGuardCard({ orgId, appId }: { orgId: string; appId: string }) {
  const url = `/api/v1/organizations/${orgId}/apps/${appId}/probe-guard`;
  const [data, setData] = useState<GuardData | null>(null);
  const [draft, setDraft] = useState<AppProbeGuard | null>(null);
  const [exceptionsText, setExceptionsText] = useState("");
  const [saving, setSaving] = useState(false);

  const apply = useCallback((next: GuardData | null) => {
    if (!next) return;
    setData(next);
    setDraft(next.settings);
    setExceptionsText(next.settings.exceptions.join("\n"));
  }, []);

  const load = useCallback(async () => apply(await requestGuard(url)), [url, apply]);

  useEffect(() => {
    let cancelled = false;
    requestGuard(url).then((next) => {
      if (!cancelled) apply(next);
    });
    return () => {
      cancelled = true;
    };
  }, [url, apply]);

  if (!data || !draft) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading probe guard...
      </div>
    );
  }

  const next: AppProbeGuard = { ...draft, exceptions: parseLines(exceptionsText) };
  const dirty = JSON.stringify(next) !== JSON.stringify(data.settings);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save");
        return;
      }
      toast.success(body?.applied === "live" ? "Probe guard saved and applied" : "Probe guard saved");
      await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-4 rounded-lg border p-4" aria-labelledby="probe-guard-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid max-w-prose gap-0.5">
          <Label id="probe-guard-heading" htmlFor="probe-guard-enabled">Turn away exploit probes</Label>
          <p className="text-xs text-muted-foreground">
            Requests for paths like /.env, /.git/ and /wp-login.php get a short 403 or 404 at the proxy and never reach the app.
            Repeat offenders are banned for a while.
          </p>
          <p className="text-xs text-muted-foreground">{guardSummary(data.stats)}</p>
        </div>
        <Switch
          id="probe-guard-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
        />
      </div>

      {!data.available && (
        <p className="text-xs text-status-warning">Set ENCRYPTION_MASTER_KEY to turn the guard on for this instance.</p>
      )}

      {draft.enabled && (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="probe-guard-wordpress">WordPress</Label>
            <Select value={draft.wordpress} onValueChange={(v) => setDraft({ ...draft, wordpress: v as AppProbeGuard["wordpress"] })}>
              <SelectTrigger id="probe-guard-wordpress" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Detect ({data.wordpressDetected ? "looks like WordPress" : "not WordPress"})</SelectItem>
                <SelectItem value="on">WordPress: allow wp-admin and xmlrpc.php</SelectItem>
                <SelectItem value="off">Not WordPress</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="probe-guard-exceptions">Exceptions</Label>
            <Textarea
              id="probe-guard-exceptions"
              rows={3}
              className="font-mono text-xs"
              placeholder="/actuator"
              value={exceptionsText}
              onChange={(e) => setExceptionsText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">One path prefix per line. Requests under these always reach the app.</p>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="grid max-w-prose gap-0.5">
              <Label htmlFor="probe-guard-robots">Serve robots.txt with trap lines</Label>
              <p className="text-xs text-muted-foreground">
                For apps without their own robots.txt. Lists {data.traps.length > 0 ? data.traps.join(", ") : "the trap paths"} as Disallow; anything that fetches one anyway is banned.
              </p>
            </div>
            <Switch id="probe-guard-robots" checked={draft.robotsTxt} onCheckedChange={(robotsTxt) => setDraft({ ...draft, robotsTxt })} />
          </div>
        </div>
      )}

      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      )}

      <div className="grid gap-2">
        <p className="type-label text-muted-foreground">Bans from this app&apos;s traffic</p>
        <BansList bans={data.bans} banUrl={(id) => `${url}/bans/${id}`} onChange={() => void load()} canBanPermanently={data.canBanPermanently} />
      </div>
    </section>
  );
}

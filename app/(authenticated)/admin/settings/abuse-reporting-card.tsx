"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { RelativeTime } from "@/components/relative-time";
import { toast } from "@/lib/messenger";
import { maskDisplay } from "@/lib/mask-secrets";
import {
  DEFAULT_ABUSE_SETTINGS,
  MAX_DAILY_CAP,
  MIN_CONFIDENCE,
  type AbuseSettings,
  type AbuseStatus,
  type BlocklistSourceStatus,
} from "@/lib/probe-guard/abuse-settings";

const ENDPOINT = "/api/v1/admin/probe-guard/abuse";

type AbuseData = {
  settings: AbuseSettings;
  apiKey: string | null;
  status: AbuseStatus;
  blocklistBans: number;
  reportedToday: number;
};

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="grid max-w-prose gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SourceLine({ status, count, noun }: { status: BlocklistSourceStatus; count: number; noun: string }) {
  if (status.error) return <p className="text-xs text-status-error">Last fetch failed: {status.error}</p>;
  if (!status.fetchedAt) return <p className="text-xs text-muted-foreground">Not fetched yet.</p>;
  return (
    <p className="text-xs text-muted-foreground">
      {count.toLocaleString("en-US")} {noun} · fetched <RelativeTime date={status.fetchedAt} />
    </p>
  );
}

async function fetchAbuse(): Promise<AbuseData | null> {
  const res = await fetch(ENDPOINT).catch(() => null);
  return res?.ok ? ((await res.json()) as AbuseData) : null;
}

/** AbuseIPDB key, reporting and the blocklists. The key is write-only from here. */
export function AbuseReportingCard() {
  const [data, setData] = useState<AbuseData | null>(null);
  const [settings, setSettings] = useState<AbuseSettings>(DEFAULT_ABUSE_SETTINGS);
  const [keyInput, setKeyInput] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const apply = useCallback((body: AbuseData | null) => {
    if (!body) return;
    setData(body);
    setSettings(body.settings);
  }, []);
  const load = useCallback(async () => apply(await fetchAbuse()), [apply]);

  useEffect(() => {
    fetchAbuse().then(apply);
  }, [apply]);

  const setReporting = (patch: Partial<AbuseSettings["reporting"]>) => setSettings((s) => ({ ...s, reporting: { ...s.reporting, ...patch } }));
  const setAbuseIpdb = (patch: Partial<AbuseSettings["blocklists"]["abuseipdb"]>) =>
    setSettings((s) => ({ ...s, blocklists: { ...s.blocklists, abuseipdb: { ...s.blocklists.abuseipdb, ...patch } } }));
  const setSpamhaus = (enabled: boolean) => setSettings((s) => ({ ...s, blocklists: { ...s.blocklists, spamhaus: { enabled } } }));

  const newKey = keyInput.trim() || undefined;
  const editingKey = replacing || !data?.apiKey;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      // Send only the fields this card owns; the API merges over the stored settings.
      const patch = {
        reporting: settings.reporting,
        blocklists: { abuseipdb: settings.blocklists.abuseipdb },
        ...(newKey ? { apiKey: newKey } : {}),
      };
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(body?.error ?? "Couldn't save abuse reporting");
        return;
      }
      toast.success("Abuse reporting saved");
      setKeyInput("");
      setReplacing(false);
      await load();
    } catch {
      toast.error("Couldn't save abuse reporting");
    } finally {
      setSaving(false);
    }
  }

  async function testKey() {
    setTesting(true);
    try {
      const res = await fetch(`${ENDPOINT}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newKey ? { apiKey: newKey } : {}),
      });
      const body = await res.json().catch(() => null);
      if (body?.ok) toast.success("AbuseIPDB accepted the key");
      else toast.error(body?.error ?? "Couldn't test the key");
    } catch {
      toast.error("Couldn't test the key");
    } finally {
      setTesting(false);
    }
  }

  if (!data) return null;
  const { status } = data;

  return (
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle>Abuse reporting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="max-w-md space-y-2">
            <Label htmlFor="abuse-key">AbuseIPDB API key</Label>
            {editingKey ? (
              <Input
                id="abuse-key"
                type="password"
                autoComplete="off"
                value={keyInput}
                placeholder={data.apiKey ? "New key" : "Paste a key"}
                onChange={(e) => setKeyInput(e.target.value)}
              />
            ) : (
              <div className="flex items-center gap-2">
                <Input id="abuse-key" value={maskDisplay(data.apiKey)} readOnly className="font-mono" />
                <Button type="button" variant="outline" onClick={() => setReplacing(true)}>
                  Replace
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => void testKey()} disabled={testing || (!newKey && !data.apiKey)}>
                {testing && <Loader2 className="size-4 animate-spin" />}
                Test key
              </Button>
              {replacing && (
                <Button type="button" size="sm" variant="ghost" onClick={() => { setReplacing(false); setKeyInput(""); }}>
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Stored encrypted. The test looks up a documentation address, never one of yours.</p>
          </div>

          <Toggle
            id="abuse-report"
            label="Report confirmed abuse"
            hint="Sends exploit attempts, trap hits, decoy credential use and credential hunting that ends in a ban. Never hostnames, names or query strings."
            checked={settings.reporting.enabled}
            onChange={(enabled) => setReporting({ enabled })}
          />
          {settings.reporting.enabled && (
            <div className="max-w-xs space-y-2">
              <Label htmlFor="abuse-cap">Reports per day</Label>
              <Input
                id="abuse-cap"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_DAILY_CAP}
                value={settings.reporting.dailyCap}
                onChange={(e) => setReporting({ dailyCap: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">{data.reportedToday.toLocaleString("en-US")} sent today. AbuseIPDB&apos;s free tier allows 1,000.</p>
            </div>
          )}
          {status.reporting.lastError && (
            <p className="text-xs text-status-error">
              Last error: {status.reporting.lastError}
              {status.reporting.lastErrorAt && <> · <RelativeTime date={status.reporting.lastErrorAt} /></>}
            </p>
          )}

          <div className="space-y-4 border-t pt-4">
            <Toggle
              id="abuse-blocklist"
              label="Import the AbuseIPDB blocklist"
              hint="Fetched daily. Listed addresses are banned for 24 hours, after your own bans."
              checked={settings.blocklists.abuseipdb.enabled}
              onChange={(enabled) => setAbuseIpdb({ enabled })}
            />
            {settings.blocklists.abuseipdb.enabled && (
              <div className="max-w-xs space-y-2">
                <Label htmlFor="abuse-confidence">Minimum confidence</Label>
                <Input
                  id="abuse-confidence"
                  type="number"
                  inputMode="numeric"
                  min={MIN_CONFIDENCE}
                  max={100}
                  value={settings.blocklists.abuseipdb.minConfidence}
                  onChange={(e) => setAbuseIpdb({ minConfidence: Number(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">The free tier only returns 100% addresses.</p>
                <SourceLine status={status.blocklists.abuseipdb} count={data.blocklistBans} noun="addresses banned" />
              </div>
            )}
            <Toggle
              id="abuse-spamhaus"
              label="Block Spamhaus DROP networks"
              hint="Hijacked and criminal networks, fetched daily. Ranges overlapping anything Vardo never bans are skipped."
              checked={settings.blocklists.spamhaus.enabled}
              onChange={setSpamhaus}
            />
            {settings.blocklists.spamhaus.enabled && (
              <SourceLine status={status.blocklists.spamhaus} count={status.blocklists.spamhaus.count} noun="ranges" />
            )}
          </div>

          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </CardContent>
      </Card>
    </form>
  );
}

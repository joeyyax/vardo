"use client";
import { DisclosureChevron } from "@/components/ui/disclosure-chevron";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "@/lib/messenger";
import { Loader2, Plus, Trash2, Bell, Filter, Send } from "lucide-react";
import { EVENT_CATEGORIES, type BusEventType, type EventCategory } from "@/lib/bus/events";
import { CATEGORY_LABELS, EVENT_LABELS } from "@/lib/notifications/labels";
import type { ChannelType } from "@/lib/notifications/channel-types";

const TYPE_LABELS: Record<ChannelType, string> = {
  email: "Email",
  webhook: "Webhook",
  slack: "Slack",
  ntfy: "ntfy",
  discord: "Discord",
  telegram: "Telegram",
  pushover: "Pushover",
};

type FieldDef = { key: string; label: string; placeholder: string; secret?: boolean; optional?: boolean };

/** Form fields for the push-style types; each sends its values under the same keys. */
const PUSH_FIELDS: Partial<Record<ChannelType, FieldDef[]>> = {
  ntfy: [
    { key: "serverUrl", label: "Server URL", placeholder: "https://ntfy.sh", optional: true },
    { key: "topic", label: "Topic", placeholder: "vardo-alerts", secret: true },
    { key: "accessToken", label: "Access token", placeholder: "tk_...", secret: true, optional: true },
    { key: "username", label: "Username", placeholder: "For servers using basic auth", optional: true },
    { key: "password", label: "Password", placeholder: "Password", secret: true, optional: true },
  ],
  discord: [{ key: "webhookUrl", label: "Webhook URL", placeholder: "https://discord.com/api/webhooks/...", secret: true }],
  telegram: [
    { key: "botToken", label: "Bot token", placeholder: "123456789:AA...", secret: true },
    { key: "chatId", label: "Chat ID", placeholder: "-1001234567890 or @channelname" },
  ],
  pushover: [
    { key: "userKey", label: "User key", placeholder: "30 characters", secret: true },
    { key: "appToken", label: "App token", placeholder: "30 characters", secret: true },
  ],
};
type Channel = { id: string; name: string; type: ChannelType; config: Record<string, unknown>; enabled: boolean; subscribedEvents: string[] };

function EventFilterEditor({
  subscribedEvents,
  onChange,
}: {
  subscribedEvents: string[];
  onChange: (events: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isAll = subscribedEvents.length === 0;

  function toggleEvent(eventType: string) {
    if (isAll) {
      // Switching from "all" to specific — select everything except the toggled one
      const allTypes = Object.values(EVENT_CATEGORIES).flat();
      onChange(allTypes.filter((t) => t !== eventType));
    } else if (subscribedEvents.includes(eventType)) {
      const next = subscribedEvents.filter((e) => e !== eventType);
      // If removing brings us back to empty, that means "all"
      onChange(next);
    } else {
      onChange([...subscribedEvents, eventType]);
    }
  }

  function isChecked(eventType: string): boolean {
    if (isAll) return true;
    return subscribedEvents.includes(eventType);
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <DisclosureChevron open={expanded} />
        <Filter className="h-3 w-3" />
        {isAll ? "All events" : `${subscribedEvents.length} event type(s)`}
      </button>

      {expanded && (
        <div className="rounded-lg bg-muted p-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Select which events this channel receives. Leave all checked to receive everything.
          </p>
          {(Object.entries(EVENT_CATEGORIES) as [EventCategory, readonly BusEventType[]][]).map(
            ([category, events]) => (
              <div key={category} className="space-y-1.5">
                <span className="type-label text-muted-foreground">
                  {CATEGORY_LABELS[category]}
                </span>
                <div className="grid grid-cols-2 gap-1">
                  {events.map((eventType) => (
                    <label
                      key={eventType}
                      className="flex items-center gap-2 text-sm cursor-pointer py-0.5"
                    >
                      <Checkbox
                        checked={isChecked(eventType)}
                        onCheckedChange={() => toggleEvent(eventType)}
                      />
                      {EVENT_LABELS[eventType] ?? eventType}
                    </label>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}

async function requestChannels(orgId: string): Promise<Channel[] | null> {
  try {
    const res = await fetch(`/api/v1/organizations/${orgId}/notifications`);
    if (!res.ok) return null;
    const d = await res.json();
    return d.channels || [];
  } catch {
    return null;
  }
}

export function NotificationChannelsEditor({ orgId }: { orgId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("email");
  const [recipients, setRecipients] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [slackUrl, setSlackUrl] = useState("");
  const [pushFields, setPushFields] = useState<Record<string, string>>({});
  const [ntfyMarkdown, setNtfyMarkdown] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);

  const applyChannels = useCallback((list: Channel[] | null) => {
    if (list) setChannels(list);
    setLoading(false);
  }, []);
  const load = useCallback(async () => {
    applyChannels(await requestChannels(orgId));
  }, [orgId, applyChannels]);
  useEffect(() => {
    let cancelled = false;
    requestChannels(orgId).then((list) => { if (!cancelled) applyChannels(list); });
    return () => { cancelled = true; };
  }, [orgId, applyChannels]);

  const reset = () => { setName(""); setType("email"); setRecipients(""); setWebhookUrl(""); setWebhookSecret(""); setSlackUrl(""); setPushFields({}); setNtfyMarkdown(true); setShowForm(false); };

  const handleCreate = async () => {
    setSaving(true);
    try {
      let config: Record<string, unknown> = {};
      if (type === "email") config = { recipients: recipients.split(",").map(e => e.trim()).filter(Boolean) };
      else if (type === "webhook") { config = { url: webhookUrl }; if (webhookSecret) config.secret = webhookSecret; }
      else if (type === "slack") config = { webhookUrl: slackUrl };
      else {
        config = Object.fromEntries(Object.entries(pushFields).filter(([, v]) => v.trim() !== ""));
        if (type === "ntfy" && !ntfyMarkdown) config.markdown = false;
      }
      const res = await fetch(`/api/v1/organizations/${orgId}/notifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, config, enabled: true }) });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }
      toast.success("Channel created"); reset(); load();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Couldn't save channel"); } finally { setSaving(false); }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try { const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }); if (res.ok) setChannels(prev => prev.map(c => c.id === id ? { ...c, enabled } : c)); } catch { toast.error("Couldn't toggle channel"); }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}/test`, { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) toast.success(d.message || "Sent");
      else toast.error(d.message || d.error || "The test failed");
    } catch { toast.error("Couldn't send the test"); } finally { setTestingId(null); }
  };

  const handleDelete = async (id: string) => {
    try { const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}`, { method: "DELETE" }); if (res.ok) { setChannels(prev => prev.filter(c => c.id !== id)); toast.success("Deleted"); } } catch { toast.error("Couldn't delete channel"); }
  };

  const handleUpdateEvents = async (id: string, subscribedEvents: string[]) => {
    try {
      const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscribedEvents }),
      });
      if (res.ok) {
        setChannels(prev => prev.map(c => c.id === id ? { ...c, subscribedEvents } : c));
      }
    } catch {
      toast.error("Couldn't update event filters");
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" />Loading...</div>;

  return (
    <Card>
      <CardContent className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Where notifications go: deploys, backups, alerts and summaries.</p>
        {!showForm && <Button size="sm" onClick={() => setShowForm(true)}><Plus className="h-4 w-4 mr-1" />Add channel</Button>}
      </div>
      {showForm && (
        <Card variant="inset" className="p-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Team alerts" /></div>
            <div className="space-y-2"><Label>Type</Label><Select value={type} onValueChange={v => { setType(v as ChannelType); setPushFields({}); }}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{(Object.keys(TYPE_LABELS) as ChannelType[]).map(t => <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
          </div>
          {type === "email" && <div className="space-y-2"><Label>Recipients (comma-separated)</Label><Input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="alice@example.com, bob@example.com" /></div>}
          {type === "webhook" && <div className="space-y-4"><div className="space-y-2"><Label>URL</Label><Input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhook" /></div><div className="space-y-2"><Label>Secret <span className="text-muted-foreground">(optional)</span></Label><Input value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} placeholder="HMAC signing secret" type="password" /></div></div>}
          {type === "slack" && <div className="space-y-2"><Label>Slack webhook URL</Label><Input value={slackUrl} onChange={e => setSlackUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." /></div>}
          {PUSH_FIELDS[type] && (
            <div className="space-y-4">
              {PUSH_FIELDS[type]!.map(f => (
                <div key={f.key} className="space-y-2">
                  <Label>{f.label}{f.optional && <span className="text-muted-foreground"> (optional)</span>}</Label>
                  <Input value={pushFields[f.key] ?? ""} onChange={e => setPushFields(prev => ({ ...prev, [f.key]: e.target.value }))} placeholder={f.placeholder} type={f.secret ? "password" : "text"} autoComplete="off" />
                </div>
              ))}
              {type === "ntfy" && <label className="flex items-center gap-2 text-sm"><Switch checked={ntfyMarkdown} onCheckedChange={setNtfyMarkdown} />Send Markdown <span className="text-muted-foreground">(ntfy 2.7 or newer)</span></label>}
            </div>
          )}
          <div className="flex gap-2"><Button size="sm" onClick={handleCreate} disabled={saving || !name}>{saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Create</Button><Button size="sm" variant="ghost" onClick={reset}>Cancel</Button></div>
        </Card>
      )}
      {channels.length === 0 && !showForm ? (
        <EmptyState
          icon={Bell}
          title="Stay in the loop"
          body="Add a notification channel to get alerted on deploy failures, backup issues and cron errors."
          action={
            <Button size="sm" onClick={() => setShowForm(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Add channel
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">{channels.map(ch => (
          <Card variant="inset" key={ch.id} className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0"><Switch checked={ch.enabled} onCheckedChange={checked => handleToggle(ch.id, checked)} /><div className="min-w-0"><div className="flex items-center gap-2"><span className="text-sm font-medium truncate">{ch.name}</span><span className="text-xs bg-muted px-1.5 py-0.5 rounded">{TYPE_LABELS[ch.type] ?? ch.type}</span></div></div></div>
              <div className="flex items-center">
                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" aria-label="Send test" title="Send test" disabled={testingId === ch.id} onClick={() => handleTest(ch.id)}>{testingId === ch.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}</Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" aria-label="Delete" onClick={() => handleDelete(ch.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
            <EventFilterEditor
              subscribedEvents={ch.subscribedEvents ?? []}
              onChange={(events) => handleUpdateEvents(ch.id, events)}
            />
          </Card>
        ))}</div>
      )}
      </CardContent>
    </Card>
  );
}

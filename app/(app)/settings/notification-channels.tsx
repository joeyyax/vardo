"use client";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Bell } from "lucide-react";

type ChannelType = "email" | "webhook" | "slack";
type Channel = { id: string; name: string; type: ChannelType; config: Record<string, unknown>; enabled: boolean };

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

  const load = useCallback(async () => {
    try { const res = await fetch(`/api/v1/organizations/${orgId}/notifications`); if (res.ok) { const d = await res.json(); setChannels(d.channels || []); } } catch {}
    setLoading(false);
  }, [orgId]);
  useEffect(() => { load(); }, [load]);

  const reset = () => { setName(""); setType("email"); setRecipients(""); setWebhookUrl(""); setWebhookSecret(""); setSlackUrl(""); setShowForm(false); };

  const handleCreate = async () => {
    setSaving(true);
    try {
      let config: Record<string, unknown> = {};
      if (type === "email") config = { recipients: recipients.split(",").map(e => e.trim()).filter(Boolean) };
      else if (type === "webhook") { config = { url: webhookUrl }; if (webhookSecret) config.secret = webhookSecret; }
      else if (type === "slack") config = { webhookUrl: slackUrl };
      const res = await fetch(`/api/v1/organizations/${orgId}/notifications`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, type, config, enabled: true }) });
      if (!res.ok) { const d = await res.json(); toast.error(d.error || "Failed"); return; }
      toast.success("Channel created"); reset(); load();
    } catch { toast.error("Failed"); } finally { setSaving(false); }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try { const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled }) }); if (res.ok) setChannels(prev => prev.map(c => c.id === id ? { ...c, enabled } : c)); } catch { toast.error("Failed"); }
  };

  const handleDelete = async (id: string) => {
    try { const res = await fetch(`/api/v1/organizations/${orgId}/notifications/${id}`, { method: "DELETE" }); if (res.ok) { setChannels(prev => prev.filter(c => c.id !== id)); toast.success("Deleted"); } } catch { toast.error("Failed"); }
  };

  if (loading) return <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 className="h-4 w-4 animate-spin" />Loading...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Configure where notifications are sent for deploy, backup, and cron failures.</p>
        {!showForm && <Button size="sm" onClick={() => setShowForm(true)} className="squircle"><Plus className="h-4 w-4 mr-1" />Add channel</Button>}
      </div>
      {showForm && (
        <div className="border border-border rounded-lg p-4 space-y-4 bg-card">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Team alerts" className="squircle" /></div>
            <div className="space-y-2"><Label>Type</Label><Select value={type} onValueChange={v => setType(v as ChannelType)}><SelectTrigger className="squircle"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="email">Email</SelectItem><SelectItem value="webhook">Webhook</SelectItem><SelectItem value="slack">Slack</SelectItem></SelectContent></Select></div>
          </div>
          {type === "email" && <div className="space-y-2"><Label>Recipients (comma-separated)</Label><Input value={recipients} onChange={e => setRecipients(e.target.value)} placeholder="alice@example.com, bob@example.com" className="squircle" /></div>}
          {type === "webhook" && <div className="space-y-4"><div className="space-y-2"><Label>URL</Label><Input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)} placeholder="https://example.com/webhook" className="squircle" /></div><div className="space-y-2"><Label>Secret <span className="text-muted-foreground">(optional)</span></Label><Input value={webhookSecret} onChange={e => setWebhookSecret(e.target.value)} placeholder="HMAC signing secret" type="password" className="squircle" /></div></div>}
          {type === "slack" && <div className="space-y-2"><Label>Slack Webhook URL</Label><Input value={slackUrl} onChange={e => setSlackUrl(e.target.value)} placeholder="https://hooks.slack.com/services/..." className="squircle" /></div>}
          <div className="flex gap-2"><Button size="sm" onClick={handleCreate} disabled={saving || !name} className="squircle">{saving && <Loader2 className="h-4 w-4 animate-spin mr-1" />}Create</Button><Button size="sm" variant="ghost" onClick={reset} className="squircle">Cancel</Button></div>
        </div>
      )}
      {channels.length === 0 && !showForm ? (
        <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border rounded-lg p-12">
          <Bell className="size-8 text-muted-foreground/50" />
          <div className="text-center space-y-1">
            <p className="text-sm font-medium">Stay in the loop</p>
            <p className="text-sm text-muted-foreground">Add a notification channel to get alerted on deploy failures, backup issues, and cron errors.</p>
          </div>
          <Button size="sm" onClick={() => setShowForm(true)} className="squircle"><Plus className="h-4 w-4 mr-1" />Add channel</Button>
        </div>
      ) : (
        <div className="space-y-2">{channels.map(ch => (
          <div key={ch.id} className="flex items-center justify-between border border-border rounded-lg p-3 bg-card">
            <div className="flex items-center gap-3 min-w-0"><Switch checked={ch.enabled} onCheckedChange={checked => handleToggle(ch.id, checked)} /><div className="min-w-0"><div className="flex items-center gap-2"><span className="text-sm font-medium truncate">{ch.name}</span><span className="text-xs bg-muted px-1.5 py-0.5 rounded">{ch.type}</span></div></div></div>
            <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(ch.id)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        ))}</div>
      )}
    </div>
  );
}

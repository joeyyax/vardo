"use client";
import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "@/lib/messenger";
import { Loader2, Bell, AlertCircle } from "lucide-react";
import { EVENT_CATEGORIES, type BusEventType, type EventCategory } from "@/lib/bus/events";
import { CRITICAL_EVENT_TYPES } from "@/lib/notifications/resolve-recipients";
import { CHANNEL_TYPE_DEFAULTS } from "@/lib/notifications/channel-defaults";

type Channel = {
  id: string;
  name: string;
  type: "email" | "slack" | "webhook";
  enabled: boolean;
};

type Preference = {
  id: string;
  channelId: string;
  eventType: string;
  enabled: boolean;
};

const CATEGORY_LABELS: Record<EventCategory, string> = {
  deploy: "Deploy",
  backup: "Backup",
  cron: "Cron",
  volume: "Volume",
  disk: "Disk",
  org: "Organization",
  security: "Security",
  system: "System",
  digest: "Digest",
};

const EVENT_LABELS: Record<BusEventType, string> = {
  "deploy.success": "Deploy succeeded",
  "deploy.failed": "Deploy failed",
  "deploy.rollback": "Auto-rollback",
  "backup.success": "Backup succeeded",
  "backup.failed": "Backup failed",
  "cron.failed": "Cron job failed",
  "volume.drift": "Volume drift detected",
  "disk.write-alert": "High disk writes",
  "org.invitation-sent": "Invitation sent",
  "org.invitation-accepted": "Invitation accepted",
  "security.file-exposed": "Sensitive file exposed",
  "system.service-down": "Service down",
  "system.disk-alert": "Disk space alert",
  "system.restart-loop": "Vardo restarted",
  "system.cert-expiring": "Certificate expiring",
  "system.update-available": "Update available",
  "digest.weekly": "Weekly digest",
};

function getEffectiveEnabled(
  channelId: string,
  channelType: string,
  eventType: string,
  prefs: Preference[],
): boolean {
  const pref = prefs.find(
    (p) => p.channelId === channelId && p.eventType === eventType,
  );
  if (pref) return pref.enabled;
  return CHANNEL_TYPE_DEFAULTS[channelType] ?? true;
}

export function UserNotificationPreferences({ orgId }: { orgId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch(
        `/api/v1/user/notification-preferences?orgId=${orgId}`,
      );
      if (!res.ok) {
        setLoadError(true);
      } else {
        const data = await res.json();
        setChannels(data.channels ?? []);
        setPrefs(data.preferences ?? []);
        setDigestEnabled(data.digestEnabled ?? false);
      }
    } catch {
      setLoadError(true);
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleEvent(
    channel: Channel,
    eventType: BusEventType,
    enabled: boolean,
  ) {
    const key = `${channel.id}:${eventType}`;
    setSaving(key);
    try {
      const res = await fetch("/api/v1/user/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "preference",
          orgId,
          channelId: channel.id,
          eventType,
          enabled,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error ?? "Failed to save preference");
        return;
      }
      setPrefs((prev) => {
        const existing = prev.find(
          (p) => p.channelId === channel.id && p.eventType === eventType,
        );
        if (existing) {
          return prev.map((p) =>
            p.channelId === channel.id && p.eventType === eventType
              ? { ...p, enabled }
              : p,
          );
        }
        return [
          ...prev,
          { id: `local-${key}`, channelId: channel.id, eventType, enabled },
        ];
      });
    } catch {
      toast.error("Failed to save preference");
    } finally {
      setSaving(null);
    }
  }

  async function toggleDigest(enabled: boolean) {
    setSaving("digest");
    try {
      const res = await fetch("/api/v1/user/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "digest", orgId, digestEnabled: enabled }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error ?? "Failed to save digest preference");
        return;
      }
      setDigestEnabled(enabled);
    } catch {
      toast.error("Failed to save digest preference");
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border rounded-lg p-12">
        <AlertCircle className="size-8 text-destructive/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">Failed to load notification preferences</p>
          <p className="text-sm text-muted-foreground">
            There was a problem fetching your preferences. Check your connection
            and{" "}
            <button
              className="underline underline-offset-2 hover:text-foreground transition-colors"
              onClick={() => {
                setLoading(true);
                load();
              }}
            >
              try again
            </button>
            .
          </p>
        </div>
      </div>
    );
  }

  if (channels.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 border border-dashed border-border rounded-lg p-12">
        <Bell className="size-8 text-muted-foreground/50" />
        <div className="text-center space-y-1">
          <p className="text-sm font-medium">No notification channels</p>
          <p className="text-sm text-muted-foreground">
            Your organization has no notification channels configured. Ask an
            admin to add one in organization settings.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {channels.map((channel) => (
        <Card key={channel.id} className="squircle rounded-lg">
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{channel.name}</span>
                <span className="text-xs bg-muted px-1.5 py-0.5 rounded">
                  {channel.type}
                </span>
                {!channel.enabled && (
                  <span className="text-xs text-muted-foreground">
                    (channel disabled by admin)
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {CHANNEL_TYPE_DEFAULTS[channel.type]
                  ? "On by default — toggle off events you don't want."
                  : "Off by default — toggle on events you want to receive."}
              </p>
            </div>

            <div className="space-y-4">
              {(
                Object.entries(EVENT_CATEGORIES) as [
                  EventCategory,
                  readonly BusEventType[],
                ][]
              ).map(([category, events]) => (
                <div key={category} className="space-y-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {CATEGORY_LABELS[category]}
                  </span>
                  <div className="space-y-1">
                    {events.map((eventType) => {
                      const isCritical = CRITICAL_EVENT_TYPES.has(eventType);
                      const enabled = isCritical
                        ? true
                        : getEffectiveEnabled(
                            channel.id,
                            channel.type,
                            eventType,
                            prefs,
                          );
                      const key = `${channel.id}:${eventType}`;

                      return (
                        <label
                          key={eventType}
                          className="flex items-center justify-between gap-3 py-1 cursor-pointer"
                        >
                          <span className="text-sm">
                            {EVENT_LABELS[eventType] ?? eventType}
                            {isCritical && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                always on
                              </span>
                            )}
                          </span>
                          {saving === key ? (
                            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                          ) : (
                            <Switch
                              checked={enabled}
                              disabled={isCritical}
                              onCheckedChange={(checked) =>
                                toggleEvent(channel, eventType, checked)
                              }
                            />
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      <Card className="squircle rounded-lg">
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Weekly digest</p>
              <p className="text-xs text-muted-foreground">
                Receive a weekly summary of org activity alongside real-time
                notifications.
              </p>
            </div>
            {saving === "digest" ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <Switch
                checked={digestEnabled}
                onCheckedChange={toggleDigest}
              />
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

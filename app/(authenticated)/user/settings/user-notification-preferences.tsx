"use client";
import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/lib/messenger";
import { Loader2, Bell, AlertCircle } from "lucide-react";
import { EVENT_CATEGORIES, type BusEventType, type EventCategory } from "@/lib/bus/events";
import { CRITICAL_EVENT_TYPES, CHANNEL_TYPE_DEFAULTS } from "@/lib/notifications/channel-defaults";

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
  app: "App",
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
  "deploy.incomplete": "Post-deploy work unfinished",
  "deploy.rollback": "Auto-rollback",
  "deploy.status": "Deploy status changed",
  "app.state-changed": "App state changed",
  "app.auto-restarted": "Container auto-restarted",
  "app.oom-killed": "Killed for memory",
  "backup.success": "Backup succeeded",
  "backup.failed": "Backup failed",
  "backup.progress": "Backup progress",
  "cron.failed": "Cron job failed",
  "volume.drift": "Volume differs from image",
  "disk.write-alert": "High disk writes",
  "org.invitation-sent": "Invitation sent",
  "org.invitation-accepted": "Invitation accepted",
  "security.file-exposed": "Sensitive file exposed",
  "security.scan-findings": "Security scan findings",
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

type PreferencesResponse = {
  channels?: Channel[];
  preferences?: Preference[];
  digestEnabled?: boolean;
};

async function requestPreferences(orgId: string): Promise<PreferencesResponse | null> {
  try {
    const res = await fetch(`/api/v1/user/notification-preferences?orgId=${orgId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function UserNotificationPreferences({ orgId }: { orgId: string }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [prefs, setPrefs] = useState<Preference[]>([]);
  const [digestEnabled, setDigestEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const [loadedOrgId, setLoadedOrgId] = useState(orgId);
  if (loadedOrgId !== orgId) {
    setLoadedOrgId(orgId);
    setLoadError(false);
  }

  const applyPreferences = useCallback((data: PreferencesResponse | null) => {
    if (data) {
      setChannels(data.channels ?? []);
      setPrefs(data.preferences ?? []);
      setDigestEnabled(data.digestEnabled ?? false);
    } else {
      setLoadError(true);
    }
    setLoading(false);
  }, []);

  const load = useCallback(async () => {
    setLoadError(false);
    applyPreferences(await requestPreferences(orgId));
  }, [orgId, applyPreferences]);

  useEffect(() => {
    let cancelled = false;
    requestPreferences(orgId).then((data) => {
      if (!cancelled) applyPreferences(data);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, applyPreferences]);

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
        toast.error(d.error ?? "Couldn't save preference");
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
      toast.error("Couldn't save preference");
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
        toast.error(d.error ?? "Couldn't save digest preference");
        return;
      }
      setDigestEnabled(enabled);
    } catch {
      toast.error("Couldn't save digest preference");
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
      <EmptyState
        icon={AlertCircle}
        title="Couldn't load notification preferences"
        body={
          <>
            There was a problem fetching your preferences. Check your connection and{" "}
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
          </>
        }
      />
    );
  }

  if (channels.length === 0) {
    return (
      <EmptyState
        icon={Bell}
        title="No notification channels"
        body="Your organization has no notification channels configured. Ask an admin to add one in organization settings."
      />
    );
  }

  return (
    <div className="space-y-6">
      {channels.map((channel) => (
        <Card key={channel.id}>
          <CardContent className="space-y-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="type-h3">{channel.name}</span>
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
                  <span className="type-label text-muted-foreground">
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

      <Card>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <p className="type-h3">Weekly digest</p>
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

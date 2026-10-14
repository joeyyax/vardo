"use client";
import { useState, useEffect, useCallback } from "react";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Term } from "@/components/term";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "@/lib/messenger";
import { Loader2, Bell, AlertCircle } from "lucide-react";
import { EVENT_CATEGORIES, type BusEventType, type EventCategory } from "@/lib/bus/events";
import { CATEGORY_LABELS, EVENT_LABELS } from "@/lib/notifications/labels";
import type { ChannelType } from "@/lib/notifications/channel-types";
import { CRITICAL_EVENT_TYPES, CHANNEL_TYPE_DEFAULTS } from "@/lib/notifications/channel-defaults";
import { DEFAULT_FREQUENCY, DIGEST_FREQUENCIES, type DigestFrequency } from "@/lib/digest/window";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Channel = {
  id: string;
  name: string;
  type: ChannelType;
  enabled: boolean;
};

type Preference = {
  id: string;
  channelId: string;
  eventType: string;
  enabled: boolean;
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
  digestFrequency?: DigestFrequency;
  projects?: { id: string; name: string }[];
  watching?: string[];
};

// The digest emails each person directly, so it has no per-channel switch.
const EMAIL_ONLY = new Set<BusEventType>(["digest.health"]);

const FREQUENCY_LABELS: Record<DigestFrequency, string> = {
  weekly: "Weekly",
  monthly: "Monthly",
  off: "Off",
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
  const [frequency, setFrequency] = useState<DigestFrequency>(DEFAULT_FREQUENCY);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [watching, setWatching] = useState<string[]>([]);
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
      setFrequency(data.digestFrequency ?? DEFAULT_FREQUENCY);
      setProjects(data.projects ?? []);
      setWatching(data.watching ?? []);
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

  async function putPreference(key: string, body: Record<string, unknown>, failure: string): Promise<boolean> {
    setSaving(key);
    try {
      const res = await fetch("/api/v1/user/notification-preferences", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orgId, ...body }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast.error(d.error ?? failure);
        return false;
      }
      return true;
    } catch {
      toast.error(failure);
      return false;
    } finally {
      setSaving(null);
    }
  }

  async function changeFrequency(next: DigestFrequency) {
    if (await putPreference("digest", { type: "digest", frequency: next }, "Couldn't save digest frequency")) setFrequency(next);
  }

  async function toggleWatch(projectId: string, next: boolean) {
    if (await putPreference(`watch:${projectId}`, { type: "watch", projectId, watching: next }, "Couldn't save watched project")) {
      setWatching((prev) => (next ? [...prev, projectId] : prev.filter((id) => id !== projectId)));
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

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor="digest-frequency" className="type-h3">
                <Term id="delivery-digest">Digest</Term>
              </Label>
              <p className="text-xs text-muted-foreground">
                Deploys, backups, alerts and resources across the organization, by email.
              </p>
            </div>
            <Select
              value={frequency}
              disabled={saving === "digest"}
              onValueChange={(v) => changeFrequency(v as DigestFrequency)}
            >
              <SelectTrigger id="digest-frequency" className="w-32 shrink-0">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_FREQUENCIES.map((f) => (
                  <SelectItem key={f} value={f}>
                    {FREQUENCY_LABELS[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {frequency !== "off" && projects.length > 0 && (
            <div className="space-y-2">
              <div>
                <span className="type-label text-muted-foreground">Watch projects</span>
                <p className="text-xs text-muted-foreground">
                  Adds each site&apos;s uptime, deploys, resources and backups to your digest.
                </p>
              </div>
              <div className="space-y-1">
                {projects.map((project) => (
                  <label key={project.id} className="flex items-center justify-between gap-3 py-1 cursor-pointer">
                    <span className="text-sm">{project.name}</span>
                    {saving === `watch:${project.id}` ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Switch
                        checked={watching.includes(project.id)}
                        onCheckedChange={(checked) => toggleWatch(project.id, checked)}
                        aria-label={`Watch ${project.name}`}
                      />
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {channels.length === 0 && (
        <EmptyState
          icon={Bell}
          title="No notification channels"
          body="Your organization has no notification channels configured. Ask an admin to add one in organization settings."
        />
      )}

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
                    {events.filter((e) => !EMAIL_ONLY.has(e)).map((eventType) => {
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

    </div>
  );
}

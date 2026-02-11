"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

type Preferences = {
  assignedToYou: boolean;
  mentioned: boolean;
  watchedTaskChanged: boolean;
  blockerResolved: boolean;
  clientComment: boolean;
  emailEnabled: boolean;
};

const PREFERENCE_ITEMS: {
  key: keyof Preferences;
  label: string;
  description: string;
}[] = [
  {
    key: "assignedToYou",
    label: "Task assignments",
    description: "When a task is assigned to you.",
  },
  {
    key: "mentioned",
    label: "Mentions",
    description: "When someone mentions you in a comment.",
  },
  {
    key: "watchedTaskChanged",
    label: "Watched task updates",
    description: "When a task you're watching has a status change or new comment.",
  },
  {
    key: "blockerResolved",
    label: "Blocker resolved",
    description: "When a blocker on one of your tasks is resolved.",
  },
  {
    key: "clientComment",
    label: "Client comments",
    description: "When a client posts a comment visible to your team.",
  },
];

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);

  const fetchPrefs = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/notifications/preferences");
      if (res.ok) {
        const data = await res.json();
        setPrefs(data);
      }
    } catch (err) {
      console.error("Error fetching notification preferences:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  const updatePref = async (key: keyof Preferences, value: boolean) => {
    if (!prefs) return;
    setUpdating(key);

    // Optimistic update
    setPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));

    try {
      const res = await fetch("/api/v1/notifications/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });

      if (!res.ok) {
        // Revert on failure
        setPrefs((prev) => (prev ? { ...prev, [key]: !value } : prev));
        toast.error("Failed to update preference");
      }
    } catch {
      setPrefs((prev) => (prev ? { ...prev, [key]: !value } : prev));
      toast.error("Failed to update preference");
    } finally {
      setUpdating(null);
    }
  };

  if (isLoading) {
    return (
      <Card className="max-w-2xl squircle" id="notifications">
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
          <CardDescription>
            Choose which notifications you receive.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!prefs) return null;

  return (
    <Card className="max-w-2xl squircle" id="notifications">
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          Choose which notifications you receive. Changes are saved automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* In-app notification types */}
        <div className="space-y-4">
          <p className="text-sm font-medium text-muted-foreground">
            In-app notifications
          </p>
          {PREFERENCE_ITEMS.map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between"
            >
              <div className="space-y-0.5">
                <Label htmlFor={`pref-${item.key}`}>{item.label}</Label>
                <p className="text-sm text-muted-foreground">
                  {item.description}
                </p>
              </div>
              <Switch
                id={`pref-${item.key}`}
                checked={prefs[item.key]}
                disabled={updating === item.key}
                onCheckedChange={(checked) => updatePref(item.key, checked)}
              />
            </div>
          ))}
        </div>

        {/* Email notifications */}
        <div className="space-y-4 border-t pt-6">
          <p className="text-sm font-medium text-muted-foreground">
            Email notifications
          </p>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="pref-emailEnabled">
                Email notifications
              </Label>
              <p className="text-sm text-muted-foreground">
                Receive email notifications in addition to in-app notifications.
              </p>
            </div>
            <Switch
              id="pref-emailEnabled"
              checked={prefs.emailEnabled}
              disabled={updating === "emailEnabled"}
              onCheckedChange={(checked) =>
                updatePref("emailEnabled", checked)
              }
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

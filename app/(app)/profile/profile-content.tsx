"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { toast } from "sonner";
import { authClient } from "@/lib/auth/client";
import { PersonalPreferences } from "@/app/(app)/settings/personal-preferences";
import { NotificationPreferences } from "@/app/(app)/settings/notification-preferences";
import { PasswordSection } from "./password-section";
import { TwoFactorSection } from "./two-factor-section";
import { PasskeySection } from "./passkey-section";

type ProfileContentProps = {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    twoFactorEnabled: boolean;
    hasPassword: boolean;
  };
};

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function ProfileContent({ user }: ProfileContentProps) {
  const router = useRouter();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [calendarIcsUrl, setCalendarIcsUrl] = useState("");
  const [savedCalendarIcsUrl, setSavedCalendarIcsUrl] = useState("");
  const [savingCalendar, setSavingCalendar] = useState(false);

  useEffect(() => {
    fetch("/api/v1/user-settings")
      .then((res) => res.json())
      .then((data) => {
        const url = data.calendarIcsUrl ?? "";
        setCalendarIcsUrl(url);
        setSavedCalendarIcsUrl(url);
      })
      .catch(() => {
        // Settings will use empty defaults
      });
  }, []);

  async function handleSaveCalendar() {
    setSavingCalendar(true);
    try {
      const res = await fetch("/api/v1/user-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarIcsUrl: calendarIcsUrl.trim() || null }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save");
      }
      const saved = calendarIcsUrl.trim() || "";
      setSavedCalendarIcsUrl(saved);
      setCalendarIcsUrl(saved);
      toast.success("Calendar feed saved");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save calendar feed";
      toast.error(message);
    } finally {
      setSavingCalendar(false);
    }
  }

  const displayName = name || user.email.split("@")[0];

  const handleSave = async () => {
    setSaving(true);
    setMessage(null);

    try {
      await authClient.updateUser({
        name: name.trim(),
      });
      setMessage({ type: "success", text: "Profile updated successfully." });
      router.refresh();
    } catch (err) {
      console.error("Failed to update profile:", err);
      setMessage({ type: "error", text: "Failed to update profile. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Profile Info */}
      <Card>
        <CardHeader>
          <CardTitle>Profile Information</CardTitle>
          <CardDescription>
            Update your personal information.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <Avatar className="size-16">
              <AvatarImage src={user.image ?? undefined} alt={displayName} />
              <AvatarFallback className="text-lg">
                {getInitials(displayName)}
              </AvatarFallback>
            </Avatar>
            <div>
              <p className="text-sm font-medium">{displayName}</p>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
          </div>

          {/* Name Field */}
          <div className="grid gap-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
            />
          </div>

          {/* Email (read-only) */}
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              value={user.email}
              disabled
              className="bg-muted"
            />
            <p className="text-xs text-muted-foreground">
              Email cannot be changed.
            </p>
          </div>

          {/* Message */}
          {message && (
            <p
              className={`text-sm ${
                message.type === "success" ? "text-green-600" : "text-destructive"
              }`}
            >
              {message.text}
            </p>
          )}

          {/* Save Button */}
          <Button onClick={handleSave} disabled={saving || name === user.name}>
            {saving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Security Section */}
      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>
            Manage your account security and authentication.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <PasswordSection hasPassword={user.hasPassword} />
          <TwoFactorSection
            enabled={user.twoFactorEnabled}
            hasPassword={user.hasPassword}
          />
          <PasskeySection />
        </CardContent>
      </Card>

      {/* Preferences */}
      <PersonalPreferences />

      {/* Calendar Integration */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle>Calendar Integration</CardTitle>
          <CardDescription>
            Connect your calendar to see events alongside your work items.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="calendar-ics-url">ICS Feed URL</Label>
            <Input
              id="calendar-ics-url"
              type="url"
              value={calendarIcsUrl}
              onChange={(e) => setCalendarIcsUrl(e.target.value)}
              placeholder="https://calendar.google.com/calendar/ical/..."
            />
            <p className="text-xs text-muted-foreground">
              Paste your Google Calendar, Outlook, or Apple Calendar ICS feed URL.
            </p>
          </div>
          <Button
            onClick={handleSaveCalendar}
            disabled={savingCalendar || calendarIcsUrl.trim() === savedCalendarIcsUrl}
          >
            {savingCalendar ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save"
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Notifications */}
      <NotificationPreferences />

      {/* Danger Zone */}
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="text-destructive">Danger Zone</CardTitle>
          <CardDescription>
            Irreversible actions that affect your account.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Delete account</p>
              <p className="text-sm text-muted-foreground">
                Permanently delete your account and all associated data.
              </p>
            </div>
            <Button variant="destructive" disabled>
              Delete account
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

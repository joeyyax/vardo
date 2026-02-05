"use client";

import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  getUserPreference,
  setUserPreference,
} from "@/lib/user-preferences";

export function PersonalPreferences() {
  const [mounted, setMounted] = useState(false);
  const [stickySelections, setStickySelections] = useState(false);

  // Load preference after mount (client-side only)
  useEffect(() => {
    setMounted(true);
    setStickySelections(getUserPreference("stickySelections"));
  }, []);

  const handleStickyChange = (checked: boolean) => {
    setStickySelections(checked);
    setUserPreference("stickySelections", checked);
  };

  // Don't render until mounted to avoid hydration mismatch
  if (!mounted) {
    return (
      <Card className="max-w-2xl squircle">
        <CardHeader>
          <CardTitle>Personal Preferences</CardTitle>
          <CardDescription>
            Customize your experience. These settings are stored locally on this device.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="h-10 animate-pulse bg-muted rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="max-w-2xl squircle">
      <CardHeader>
        <CardTitle>Personal Preferences</CardTitle>
        <CardDescription>
          Customize your experience. These settings are stored locally on this device.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="sticky-selections">Keep selections after save</Label>
              <p className="text-sm text-muted-foreground">
                Keep client, project, task, and date selections when creating new entries.
                Hold Shift while saving to temporarily invert this behavior.
              </p>
            </div>
            <Switch
              id="sticky-selections"
              checked={stickySelections}
              onCheckedChange={handleStickyChange}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

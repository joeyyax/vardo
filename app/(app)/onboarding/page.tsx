"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Generate slug preview from name
  const slugPreview = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Please enter an organization name.");
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/v1/organizations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: name.trim() }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to create organization");
      }

      // Success - redirect to track page
      router.push("/track");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md squircle">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome to Time</CardTitle>
          <CardDescription>
            Let&apos;s set up your workspace. You can always change this later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Organization name</Label>
              <Input
                id="name"
                type="text"
                placeholder="Acme Inc."
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
                autoFocus
                className="squircle"
              />
              {slugPreview && (
                <p className="text-xs text-muted-foreground">
                  Your workspace URL will include: {slugPreview}
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full squircle"
              disabled={isLoading || !name.trim()}
            >
              {isLoading ? "Creating..." : "Create workspace"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Building2, Loader2 } from "lucide-react";

export function TeamInvitationAccept({
  token,
  type,
  organizationName,
}: {
  token: string;
  type: "invitation" | "join";
  organizationName: string;
}) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setAccepting(true);
    setError(null);

    try {
      const response = await fetch("/api/v1/team-invitations/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, type }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to join organization");
      }

      // Set the current org cookie
      document.cookie = `time_current_org=${data.organizationId};path=/;max-age=${60 * 60 * 24 * 365}`;

      router.push("/track");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="squircle w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Building2 className="size-6 text-primary" />
          </div>
          <CardTitle>Join {organizationName}</CardTitle>
          <p className="text-sm text-muted-foreground mt-2">
            You&apos;ve been invited to join this organization.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
          <Button
            onClick={handleAccept}
            disabled={accepting}
            className="squircle w-full"
          >
            {accepting && <Loader2 className="size-4 animate-spin" />}
            Join Organization
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

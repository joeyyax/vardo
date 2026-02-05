"use client";

import { useState, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Folder, Loader2, XCircle } from "lucide-react";

type InvitationInfo = {
  id: string;
  email: string;
  role: "viewer" | "contributor";
  accepted: boolean;
  project: {
    id: string;
    name: string;
  };
  organization: {
    id: string;
    name: string;
  };
};

export default function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const [invitation, setInvitation] = useState<InvitationInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    async function fetchInvitation() {
      try {
        const response = await fetch(`/api/invitations/${token}`);
        if (!response.ok) {
          if (response.status === 404) {
            throw new Error("This invitation link is invalid or has expired.");
          }
          throw new Error("Failed to load invitation");
        }
        const data = await response.json();
        setInvitation(data);

        // If already accepted, redirect to portal
        if (data.accepted) {
          router.push(`/portal/${data.project.id}`);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong");
      } finally {
        setIsLoading(false);
      }
    }

    fetchInvitation();
  }, [token, router]);

  async function handleAccept() {
    if (!invitation) return;

    setIsAccepting(true);
    setError(null);

    try {
      // First, try to accept directly (will check if user is logged in)
      const response = await fetch(`/api/invitations/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await response.json();

      if (data.requiresAuth) {
        // User needs to log in - redirect to login with return URL
        const returnUrl = encodeURIComponent(`/invite/${token}`);
        router.push(`/login?redirect=${returnUrl}&email=${encodeURIComponent(invitation.email)}`);
        return;
      }

      if (!response.ok) {
        throw new Error(data.error || "Failed to accept invitation");
      }

      setSuccess(true);

      // Redirect to the project in portal
      setTimeout(() => {
        router.push(`/portal/${invitation.project.id}`);
      }, 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setIsAccepting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="squircle w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
            <p className="mt-4 text-muted-foreground">Loading invitation...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !invitation) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="squircle w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
              <XCircle className="size-6 text-destructive" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Invitation Error</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {error || "This invitation link is invalid or has expired."}
            </p>
            <Button asChild className="mt-6 squircle">
              <Link href="/">Go to homepage</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (success) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="squircle w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
              <CheckCircle2 className="size-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h2 className="mt-4 text-lg font-semibold">Invitation Accepted!</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              You now have access to {invitation.project.name}. Redirecting...
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="squircle w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Folder className="size-6 text-primary" />
          </div>
          <CardTitle>You&apos;re Invited!</CardTitle>
          <CardDescription>
            You&apos;ve been invited to collaborate on a project
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Project info */}
          <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
            <div>
              <p className="text-sm text-muted-foreground">Project</p>
              <p className="font-medium">{invitation.project.name}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Organization</p>
              <p className="font-medium">{invitation.organization.name}</p>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-muted-foreground">Your role</p>
                <p className="font-medium capitalize">{invitation.role}</p>
              </div>
              <Badge
                variant={invitation.role === "contributor" ? "default" : "secondary"}
                className="squircle"
              >
                {invitation.role === "contributor" ? "Can edit" : "View only"}
              </Badge>
            </div>
          </div>

          {/* Invitation email note */}
          <p className="text-sm text-center text-muted-foreground">
            This invitation was sent to{" "}
            <span className="font-medium text-foreground">{invitation.email}</span>
          </p>

          {/* Action buttons */}
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleAccept}
              disabled={isAccepting}
              className="squircle w-full"
            >
              {isAccepting && <Loader2 className="size-4 animate-spin" />}
              Accept Invitation
            </Button>
            <Button
              variant="ghost"
              asChild
              className="squircle w-full"
            >
              <Link href="/">Decline</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

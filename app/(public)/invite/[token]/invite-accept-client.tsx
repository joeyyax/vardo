"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { notify } from "@/lib/notify";
import { Loader2, Mail, KeyRound } from "lucide-react";
import { DEFAULT_APP_NAME } from "@/lib/constants";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { signIn } from "@/lib/auth/client";

type Props = {
  email: string;
  orgName?: string;
  inviterName?: string;
  isLoggedIn: boolean;
  loggedInEmail?: string;
  acceptAction: () => Promise<{ error?: string }>;
};

export function InviteAcceptClient({
  email,
  orgName,
  inviterName,
  isLoggedIn,
  loggedInEmail,
  acceptAction,
}: Props) {
  const router = useRouter();
  const [accepting, setAccepting] = useState(false);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [signingIn, setSigningIn] = useState<string | null>(null);

  const heading = orgName
    ? `You've been invited to ${orgName}`
    : `You've been invited to ${DEFAULT_APP_NAME}`;

  const description = inviterName
    ? `${inviterName} invited you to join ${orgName || DEFAULT_APP_NAME}.`
    : `You've been invited to join ${orgName || DEFAULT_APP_NAME}.`;

  async function handleAccept() {
    setAccepting(true);
    try {
      const result = await acceptAction();
      if (result?.error) {
        notify.toast.error(result.error);
        return;
      }
      notify.toast.success("Invitation accepted!");
      router.push("/projects");
    } catch {
      notify.toast.error("Failed to accept invitation");
    } finally {
      setAccepting(false);
    }
  }

  async function handleMagicLink() {
    setSigningIn("magic");
    try {
      const result = await signIn.magicLink({
        email,
        callbackURL: window.location.pathname,
      });
      if (result?.error) {
        notify.toast.error(result.error.message ?? "Failed to send magic link");
      } else {
        setMagicLinkSent(true);
      }
    } catch {
      notify.toast.error("Failed to send magic link");
    } finally {
      setSigningIn(null);
    }
  }

  async function handlePasskey() {
    setSigningIn("passkey");
    try {
      const result = await signIn.passkey({
        fetchOptions: {
          onSuccess: () => {
            router.refresh();
          },
        },
      });
      if (result?.error) {
        notify.toast.error(result.error.message ?? "Passkey sign in failed");
      }
    } catch {
      notify.toast.error("Passkey sign in failed");
    } finally {
      setSigningIn(null);
    }
  }

  if (magicLinkSent) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <Card className="w-full max-w-md squircle rounded-2xl">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center">
              <Mail className="w-6 h-6 text-primary" />
            </div>
            <CardTitle>Check your email</CardTitle>
            <CardDescription className="mt-2">
              We sent a sign-in link to <strong>{email}</strong>
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <p className="text-sm text-muted-foreground">
              Click the link in your email to sign in and accept the invitation.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md squircle rounded-2xl">
        <CardHeader className="text-center">
          <CardTitle>{heading}</CardTitle>
          <CardDescription className="mt-2">{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoggedIn && loggedInEmail !== email && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
              You are signed in as <strong>{loggedInEmail}</strong>, but this invitation
              was sent to <strong>{email}</strong>. Sign in with the correct account to
              accept.
            </div>
          )}

          {isLoggedIn && loggedInEmail === email ? (
            <Button
              className="w-full h-11 squircle rounded-lg"
              onClick={handleAccept}
              disabled={accepting}
            >
              {accepting && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Accept invitation
            </Button>
          ) : (
            <>
              <p className="text-sm text-muted-foreground text-center">
                Sign in to accept this invitation
              </p>

              <Button
                variant="default"
                className="w-full h-11 squircle rounded-lg"
                onClick={handlePasskey}
                disabled={signingIn !== null}
              >
                {signingIn === "passkey" ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <KeyRound className="w-4 h-4 mr-2" />
                )}
                Sign in with Passkey
              </Button>

              <Button
                variant="outline"
                className="w-full h-11 squircle rounded-lg"
                onClick={handleMagicLink}
                disabled={signingIn !== null}
              >
                {signingIn === "magic" ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Mail className="w-4 h-4 mr-2" />
                )}
                Send magic link to {email}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

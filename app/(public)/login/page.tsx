"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "@/lib/auth/client";
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
import { Separator } from "@/components/ui/separator";
import { KeyRound, Mail, Loader2 } from "lucide-react";

export default function LoginPage() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/track";

  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState<string | null>(null);
  const [magicLinkSent, setMagicLinkSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePasskeySignIn = async () => {
    setIsLoading("passkey");
    setError(null);
    try {
      const result = await signIn.passkey({
        fetchOptions: {
          onSuccess: () => {
            window.location.href = callbackUrl;
          },
        },
      });
      if (result?.error) {
        setError(result.error.message ?? "Passkey sign in failed");
      }
    } catch {
      setError("Passkey sign in failed. Make sure you have a passkey set up.");
    } finally {
      setIsLoading(null);
    }
  };

  const handleMagicLinkSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;

    setIsLoading("magic");
    setError(null);
    try {
      const result = await signIn.magicLink({
        email,
        callbackURL: callbackUrl,
      });
      if (result?.error) {
        setError(result.error.message ?? "Failed to send magic link");
      } else {
        setMagicLinkSent(true);
      }
    } catch {
      setError("Failed to send magic link");
    } finally {
      setIsLoading(null);
    }
  };

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
            <p className="text-sm text-muted-foreground mb-4">
              Click the link in your email to sign in. It expires in 10 minutes.
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                setMagicLinkSent(false);
                setEmail("");
              }}
            >
              Use a different method
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Card className="w-full max-w-md squircle rounded-2xl">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Welcome back</CardTitle>
          <CardDescription>
            Sign in to continue tracking your time
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg">
              {error}
            </div>
          )}

          {/* Passkey - Primary method */}
          <Button
            variant="default"
            className="w-full h-11 squircle rounded-lg"
            onClick={handlePasskeySignIn}
            disabled={isLoading !== null}
          >
            {isLoading === "passkey" ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <KeyRound className="w-4 h-4 mr-2" />
            )}
            Sign in with Passkey
          </Button>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <Separator />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                or use email
              </span>
            </div>
          </div>

          {/* Magic link */}
          <form onSubmit={handleMagicLinkSignIn} className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="email">Email address</Label>
              <Input
                id="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-11 squircle rounded-lg"
                disabled={isLoading !== null}
                required
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="w-full h-11 squircle rounded-lg"
              disabled={isLoading !== null || !email}
            >
              {isLoading === "magic" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Mail className="w-4 h-4 mr-2" />
              )}
              Send magic link
            </Button>
          </form>

          <p className="text-xs text-center text-muted-foreground pt-2">
            Don&apos;t have an account? Just sign in and we&apos;ll create one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

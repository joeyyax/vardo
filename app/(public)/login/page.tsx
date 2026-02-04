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
import { KeyRound, Github, Mail, Loader2 } from "lucide-react";

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

  const handleOAuthSignIn = async (provider: "github" | "google") => {
    setIsLoading(provider);
    setError(null);
    try {
      await signIn.social({
        provider,
        callbackURL: callbackUrl,
      });
    } catch {
      setError(`${provider} sign in failed`);
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
                or continue with
              </span>
            </div>
          </div>

          {/* OAuth providers */}
          <div className="grid grid-cols-2 gap-3">
            <Button
              variant="outline"
              className="h-11 squircle rounded-lg"
              onClick={() => handleOAuthSignIn("github")}
              disabled={isLoading !== null}
            >
              {isLoading === "github" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Github className="w-4 h-4 mr-2" />
              )}
              GitHub
            </Button>
            <Button
              variant="outline"
              className="h-11 squircle rounded-lg"
              onClick={() => handleOAuthSignIn("google")}
              disabled={isLoading !== null}
            >
              {isLoading === "google" ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24">
                  <path
                    fill="currentColor"
                    d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  />
                  <path
                    fill="currentColor"
                    d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  />
                  <path
                    fill="currentColor"
                    d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  />
                </svg>
              )}
              Google
            </Button>
          </div>

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

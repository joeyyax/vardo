"use client";

import { Suspense, useState } from "react";
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

function LoginForm() {
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") ?? "/projects";

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
    );
  }

  return (
    <Card className="w-full max-w-md squircle rounded-2xl">
      <CardContent className="space-y-4 pt-6">
        {error && (
          <div
            role="alert"
            className="p-3 text-sm text-destructive bg-destructive/10 rounded-lg"
          >
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

        {/* GitHub OAuth */}
        <Button
          variant="outline"
          className="w-full h-11 squircle rounded-lg"
          onClick={async () => {
            setIsLoading("github");
            setError(null);
            try {
              await signIn.social({
                provider: "github",
                callbackURL: callbackUrl,
              });
            } catch {
              setError("GitHub sign in failed");
              setIsLoading(null);
            }
          }}
          disabled={isLoading !== null}
        >
          {isLoading === "github" ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
          )}
          Sign in with GitHub
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
      </CardContent>
    </Card>
  );
}

function LoginSkeleton() {
  return (
    <Card className="w-full max-w-md squircle rounded-2xl">
      <CardContent className="space-y-4 pt-6">
        <div className="h-11 bg-muted animate-pulse rounded-lg" />
        <div className="h-4" />
        <div className="space-y-3">
          <div className="h-11 bg-muted animate-pulse rounded-lg" />
          <div className="h-11 bg-muted animate-pulse rounded-lg" />
        </div>
      </CardContent>
    </Card>
  );
}

export function LoginPageClient() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <Suspense fallback={<LoginSkeleton />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}

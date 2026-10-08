"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

/** First page of setup: asks for the token the installer printed. A `?token=` link submits itself. */
export function SetupTokenGate({ unset = false }: { unset?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoTried = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(value: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: value }),
      });
      if (res.ok) {
        router.replace(pathname);
        router.refresh();
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't check the token. Try again.");
    } catch {
      setError("Couldn't reach the server. Try again.");
    }
    setLoading(false);
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  useEffect(() => {
    if (unset || autoTried.current) return;
    autoTried.current = true;
    const linked = new URLSearchParams(window.location.search).get("token");
    if (!linked) return;
    window.history.replaceState(null, "", pathname);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void submit(linked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md rounded-2xl">
        <CardHeader className="text-center">
          <h1 className="type-h2">Enter your setup token</h1>
          <CardDescription className="mt-1">
            {unset ? "This instance has no setup token. Run " : "The installer printed it. To see it again, run "}
            <code className="whitespace-nowrap font-mono text-foreground">vardo setup-token</code> on the host
            {unset ? ", then reload this page." : "."}
          </CardDescription>
        </CardHeader>
        {!unset && (
          <CardContent>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void submit(token);
              }}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="setup-token" className="sr-only">
                  Setup token
                </Label>
                <Input
                  id="setup-token"
                  ref={inputRef}
                  className="font-mono"
                  placeholder="Setup token"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  autoFocus
                  required
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "setup-token-error" : undefined}
                />
                {error && (
                  <p id="setup-token-error" role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? <Loader2 className="size-4 animate-spin" /> : "Continue"}
              </Button>
            </form>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/messenger";
import { ResourcesSummary } from "./resources-summary";

/** First page after the setup token: create the first admin. Restore is the quiet alternative. */
export function SetupWizard() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { error } = await signUp.email({ name, email, password });
      if (error) {
        setError(error.message || "Couldn't create the account. Try again.");
        return;
      }
      toast.success("Account created");
      router.push("/projects");
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <Card className="w-full max-w-md rounded-2xl">
        <CardHeader className="text-center">
          <h1 className="type-h2">Create your admin account</h1>
          <CardDescription className="mt-1">You&apos;ll use it to sign in and manage this instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                aria-describedby="password-hint"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
              <p id="password-hint" className="text-xs text-muted-foreground">
                At least 8 characters.
              </p>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>
      <ResourcesSummary />
      <div className="text-center text-sm text-muted-foreground">
        <p>Moving from another instance?</p>
        <Link href="/setup/restore" className="text-foreground underline underline-offset-4 hover:no-underline">
          Restore from backup instead
        </Link>
      </div>
    </div>
  );
}

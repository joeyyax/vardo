"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { signUp } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { ArchiveRestore, Loader2, Sparkles } from "lucide-react";
import { toast } from "@/lib/messenger";

/** First page after install: start fresh, or bring back an instance from its backups. */
export function SetupWizard() {
  const [mode, setMode] = useState<"choose" | "new">("choose");
  if (mode === "new") return <NewInstanceForm onBack={() => setMode("choose")} />;

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-6">
        <div className="text-center">
          <h1 className="type-h2">Welcome to Vardo</h1>
          <p className="mt-1 text-sm text-muted-foreground">How do you want to start this instance?</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setMode("new")}
            className="squircle rounded-2xl border bg-card p-6 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Sparkles className="size-5 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 font-medium">Set up as new</h2>
            <p className="mt-1 text-sm text-muted-foreground">Create the first admin account and start with no apps.</p>
          </button>
          <Link
            href="/setup/restore"
            className="squircle rounded-2xl border bg-card p-6 text-left transition-colors hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArchiveRestore className="size-5 text-muted-foreground" aria-hidden />
            <h2 className="mt-3 font-medium">Restore from backup</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Bring back Vardo&apos;s database, then every app, from a backup bucket. You sign in with an account from the backup.
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}

function NewInstanceForm({ onBack }: { onBack: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await signUp.email({ name, email, password });
      if (error) {
        toast.error(error.message || "Couldn't create account");
        return;
      }
      toast.success("Account created — you're the admin");
      router.push("/projects");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't create account",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-md rounded-2xl">
        <CardHeader className="text-center">
          <h1 className="type-h2">Welcome to Vardo</h1>
          <CardDescription className="mt-1">
            Create your admin account to get started
          </CardDescription>
          <p className="text-xs text-muted-foreground mt-2">
            Self-hosted PaaS for Docker Compose
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
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
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Create account"
              )}
            </Button>
            <Button type="button" variant="ghost" className="w-full" onClick={onBack}>
              Back
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

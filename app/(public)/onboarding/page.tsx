"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { signUp, signIn, useSession } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Github, ArrowRight, Loader2 } from "lucide-react";
import { toast } from "sonner";

type Step = "account" | "github" | "org";

export default function OnboardingPage() {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [step, setStep] = useState<Step>("account");
  const [loading, setLoading] = useState(false);

  // Account form
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // GitHub state
  const [githubConnected, setGithubConnected] = useState(false);
  const [checkingGithub, setCheckingGithub] = useState(false);

  // Org form
  const [orgName, setOrgName] = useState("");

  // Skip account creation if already signed in (e.g. via OAuth)
  useEffect(() => {
    if (session && step === "account") {
      setStep("github");
    }
  }, [session, step]);

  // Check if GitHub is already connected when we reach that step
  useEffect(() => {
    if (step !== "github") return;
    let cancelled = false;
    async function check() {
      setCheckingGithub(true);
      try {
        const res = await fetch("/api/v1/github/installations");
        if (res.ok && !cancelled) {
          const data = await res.json();
          setGithubConnected((data.installations || []).length > 0);
        }
      } catch { /* skip */ }
      finally { if (!cancelled) setCheckingGithub(false); }
    }
    check();
    return () => { cancelled = true; };
  }, [step]);

  async function handleCreateAccount(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const { error } = await signUp.email({ name, email, password });
      if (error) {
        toast.error(error.message || "Failed to create account");
        return;
      }
      toast.success("Account created");
      setStep("github");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  async function handleConnectGithub() {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/github/connect");
      if (res.ok) {
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url;
          return;
        }
      }
      toast.error("Failed to start GitHub connection");
    } catch {
      toast.error("Failed to connect GitHub");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateOrg(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const slug = orgName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const res = await fetch("/api/v1/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: orgName, slug }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create organization");
        return;
      }

      toast.success("Organization created");
      router.push("/projects");
    } catch {
      toast.error("Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  if (isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const stepIndex = step === "account" ? 0 : step === "github" ? 1 : 2;
  const totalSteps = session ? 2 : 3; // Skip account step count if already signed in

  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Step indicator */}
        <div className="flex items-center justify-center gap-1.5">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1 rounded-full transition-all ${
                i <= (session ? stepIndex - 1 : stepIndex)
                  ? "w-8 bg-primary"
                  : "w-4 bg-muted"
              }`}
            />
          ))}
        </div>

        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {step === "account"
              ? "Create your account"
              : step === "github"
              ? "Connect GitHub"
              : "Create an organization"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {step === "account"
              ? "Set up your admin account."
              : step === "github"
              ? "Deploy directly from your repositories."
              : "Organizations group your apps and team together."}
          </p>
        </div>

        {step === "account" && (
          <form onSubmit={handleCreateAccount} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
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
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : "Continue"}
            </Button>
          </form>
        )}

        {step === "github" && (
          <div className="space-y-4">
            {checkingGithub ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : githubConnected ? (
              <div className="rounded-lg border bg-status-success-muted p-4 text-center">
                <p className="text-sm text-status-success font-medium">GitHub connected</p>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full h-12"
                onClick={handleConnectGithub}
                disabled={loading}
              >
                {loading ? (
                  <Loader2 className="size-4 animate-spin mr-2" />
                ) : (
                  <Github className="size-5 mr-2" />
                )}
                Connect GitHub
              </Button>
            )}
            <Button
              className="w-full"
              onClick={() => setStep("org")}
            >
              {githubConnected ? "Continue" : "Skip for now"}
              <ArrowRight className="size-4 ml-2" />
            </Button>
          </div>
        )}

        {step === "org" && (
          <form onSubmit={handleCreateOrg} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="orgName">Organization name</Label>
              <Input
                id="orgName"
                placeholder="e.g. Joey Yax, LLC"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="size-4 animate-spin" /> : "Get started"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

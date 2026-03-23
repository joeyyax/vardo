"use client";

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { Github, Loader2, ExternalLink, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

type Installation = {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  accountAvatarUrl: string | null;
  createdAt: string;
};

export function GitHubConnection() {
  const searchParams = useSearchParams();
  const [installations, setInstallations] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Show toast based on callback result
  useEffect(() => {
    const github = searchParams.get("github");
    if (github === "connected") {
      toast.success("GitHub account connected");
    } else if (github === "pending") {
      toast.info("GitHub installation pending approval");
    } else if (github === "error") {
      toast.error("Failed to connect GitHub account");
    }
  }, [searchParams]);

  // Fetch installations
  useEffect(() => {
    async function fetchInstallations() {
      try {
        const res = await fetch("/api/v1/github/installations");
        if (res.ok) {
          const data = await res.json();
          setInstallations(data.installations || []);
        }
      } catch {
        console.error("Failed to fetch GitHub installations");
      } finally {
        setLoading(false);
      }
    }
    fetchInstallations();
  }, []);

  async function handleConnect() {
    setConnecting(true);
    try {
      const res = await fetch("/api/v1/github/connect");
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to generate connect URL");
        return;
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch {
      toast.error("Failed to connect to GitHub");
      setConnecting(false);
    }
  }

  async function handleRemove(id: string) {
    setRemoving(id);
    try {
      const res = await fetch("/api/v1/github/installations", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setInstallations((prev) => prev.filter((i) => i.id !== id));
        toast.success("GitHub account disconnected");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to disconnect");
      }
    } catch {
      toast.error("Failed to disconnect GitHub account");
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card className="squircle rounded-lg">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>GitHub</CardTitle>
            <CardDescription>Link a GitHub account to deploy from private repos and enable auto-deploy on push.</CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Github className="mr-1.5 size-4" />
            )}
            Connect GitHub
          </Button>
        </div>
      </CardHeader>
      <CardContent>
      {loading ? (
        <div className="flex items-center justify-center p-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : installations.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 p-8">
          <Github className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No GitHub accounts connected yet.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {installations.map((installation) => (
            <div
              key={installation.id}
              className="flex items-center gap-3 rounded-lg border p-3"
            >
              {installation.accountAvatarUrl ? (
                <img
                  src={installation.accountAvatarUrl}
                  alt={installation.accountLogin}
                  className="size-8 rounded-full"
                />
              ) : (
                <div className="flex size-8 items-center justify-center rounded-full bg-muted">
                  <Github className="size-4" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {installation.accountLogin}
                  </span>
                  <Badge variant="secondary" className="text-xs">
                    {installation.accountType}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Connected{" "}
                  {new Date(installation.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" asChild>
                  <a
                    href="https://github.com/settings/installations"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleRemove(installation.id)}
                  disabled={removing === installation.id}
                >
                  {removing === installation.id ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4 text-destructive" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      </CardContent>
    </Card>
  );
}

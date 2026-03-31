"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Loader2,
  FolderOpen,
  AlertCircle,
  Check,
  RefreshCw,
  Info,
} from "lucide-react";
import { toast } from "@/lib/messenger";

type DockerConfig = {
  externalProjectsPath: string | null;
  vardoRole: string;
  configured: boolean;
  accessible: boolean;
  directories: string[];
};

export function DockerSettings() {
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);
  const [config, setConfig] = useState<DockerConfig | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/v1/admin/docker");
        if (res.ok) {
          setConfig(await res.json());
        }
      } catch {
        // Failed to load
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleRestart() {
    setRestarting(true);
    try {
      const res = await fetch("/api/v1/admin/restart", { method: "POST" });
      if (!res.ok) throw new Error("Failed to restart");
      toast.success("Restarting Vardo...", {
        description: "The page will refresh automatically.",
      });
      setTimeout(() => window.location.reload(), 5000);
    } catch {
      toast.error("Failed to restart Vardo");
      setRestarting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">Docker</h2>
        <p className="text-sm text-muted-foreground">
          Docker integration settings and volume mounts.
        </p>
      </div>

      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <FolderOpen className="size-4" />
            External Projects Path
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {config?.externalProjectsPath ? (
            <>
              <div className="flex items-center gap-2">
                <code className="px-2 py-1 bg-muted rounded text-sm font-mono">
                  {config.externalProjectsPath}
                </code>
                {config.accessible ? (
                  <Badge variant="outline" className="gap-1 text-status-success border-status-success">
                    <Check className="size-3" />
                    Accessible
                  </Badge>
                ) : (
                  <Badge variant="outline" className="gap-1 text-status-warning border-status-warning">
                    <AlertCircle className="size-3" />
                    Not accessible
                  </Badge>
                )}
              </div>
              {config.accessible && config.directories.length > 0 && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Found {config.directories.length} project{config.directories.length === 1 ? "" : "s"}:
                  </p>
                  <ul className="text-sm space-y-1 max-h-32 overflow-y-auto">
                    {config.directories.slice(0, 10).map((dir) => (
                      <li key={dir} className="font-mono text-xs text-muted-foreground">
                        {dir}
                      </li>
                    ))}
                    {config.directories.length > 10 && (
                      <li className="text-xs text-muted-foreground">
                        ...and {config.directories.length - 10} more
                      </li>
                    )}
                  </ul>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Vardo can auto-detect git repos when importing compose projects from this path.
              </p>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex items-start gap-2 text-muted-foreground">
                <Info className="size-4 shrink-0 mt-0.5" />
                <p className="text-sm">
                  No external projects path configured. Vardo cannot auto-detect git
                  repos during compose import.
                </p>
              </div>
              <div className="bg-muted p-3 rounded-lg space-y-2">
                <p className="text-sm font-medium">To enable git auto-detection:</p>
                <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
                  <li>
                    Add to your <code className="text-xs bg-background px-1 py-0.5 rounded">.env</code> file:
                    <pre className="mt-1 p-2 bg-background rounded text-xs font-mono">
                      EXTERNAL_PROJECTS_PATH=/path/to/compose/projects
                    </pre>
                  </li>
                  <li>Restart Vardo for changes to take effect</li>
                </ol>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="squircle">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <RefreshCw className="size-4" />
            Restart Vardo
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Restart the Vardo container to apply configuration changes from <code className="text-xs">.env</code>.
          </p>
          <Button
            variant="outline"
            onClick={handleRestart}
            disabled={restarting}
            className="squircle"
          >
            {restarting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Restarting...
              </>
            ) : (
              <>
                <RefreshCw className="size-4" />
                Restart Vardo
              </>
            )}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

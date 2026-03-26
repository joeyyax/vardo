"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Globe, HardDrive } from "lucide-react";
import type { DiscoveredContainer } from "@/lib/docker/discover";

type ContainerCardProps = {
  container: DiscoveredContainer;
  onImport: (container: DiscoveredContainer) => void;
};

export function ContainerCard({ container, onImport }: ContainerCardProps) {
  const isRunning = container.state === "running";

  return (
    <div className="squircle border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{container.name}</span>
            <Badge variant={isRunning ? "default" : "secondary"} className="shrink-0">
              {container.state}
            </Badge>
            {container.composeProject && (
              <Badge variant="outline" className="shrink-0 text-xs">
                {container.composeProject}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">{container.image}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => onImport(container)}
          aria-label={`Import ${container.name}`}
        >
          Import
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {container.domain && (
          <span className="flex items-center gap-1">
            <Globe className="size-3" />
            {container.domain}
          </span>
        )}
        {container.ports.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="font-mono">
              {container.ports
                .map((p) =>
                  p.external ? `${p.external}:${p.internal}` : String(p.internal)
                )
                .join(", ")}
            </span>
          </span>
        )}
        {container.mounts.length > 0 && (
          <span className="flex items-center gap-1">
            <HardDrive className="size-3" />
            {container.mounts.length} mount{container.mounts.length !== 1 ? "s" : ""}
          </span>
        )}
        {container.networkMode === "host" && (
          <Badge variant="outline" className="text-xs">host network</Badge>
        )}
      </div>
    </div>
  );
}

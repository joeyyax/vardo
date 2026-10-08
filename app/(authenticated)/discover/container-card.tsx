"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Globe, HardDrive, Cpu } from "lucide-react";
import type { DiscoveredContainer } from "@/lib/docker/discover";
import { containerStateVariant } from "@/lib/ui/container-state";

type ContainerCardProps = {
  container: DiscoveredContainer;
  onImport?: (container: DiscoveredContainer) => void;
  /** Inside a compose group card: sits on the tray ground instead of lifting. */
  nested?: boolean;
};

export function ContainerCard({ container, onImport, nested }: ContainerCardProps) {
  return (
    <Card variant={nested ? "inset" : "surface"} className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{container.name}</span>
            <Badge variant={containerStateVariant(container.state)} className="shrink-0">
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
        {onImport && (
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => onImport(container)}
            aria-label={`Import ${container.name}`}
          >
            Import
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {container.domain && (
          <span className="flex items-center gap-1">
            <Globe aria-hidden="true" className="size-3" />
            {container.domain}
          </span>
        )}
        {container.ports.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="font-mono">
              {[
                ...new Set(
                  container.ports.map((p) =>
                    p.external ? `${p.external}:${p.internal}` : String(p.internal)
                  ),
                ),
              ].join(", ")}
            </span>
          </span>
        )}
        {container.mounts.length > 0 && (
          <span className="flex items-center gap-1">
            <HardDrive aria-hidden="true" className="size-3" />
            {container.mounts.length} mount{container.mounts.length !== 1 ? "s" : ""}
          </span>
        )}
        {container.hasGpu && (
          <span className="flex items-center gap-1">
            <Cpu aria-hidden="true" className="size-3" />
            GPU
          </span>
        )}
        {container.networkMode === "host" && (
          <Badge variant="outline" className="text-xs">host network</Badge>
        )}
      </div>
    </Card>
  );
}

"use client";

import { Badge } from "@/components/ui/badge";
import { ContainerCard } from "./container-card";
import type { DiscoveredContainer } from "@/lib/docker/discover";

type ComposeGroupCardProps = {
  composeProject: string;
  containers: DiscoveredContainer[];
  orgId: string;
  onImport: (container: DiscoveredContainer) => void;
};

export function ComposeGroupCard({
  composeProject,
  containers,
  orgId,
  onImport,
}: ComposeGroupCardProps) {
  return (
    <div className="squircle border bg-card/50 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="font-medium text-sm">{composeProject}</span>
        <Badge variant="outline" className="text-xs">
          {containers.length} service{containers.length !== 1 ? "s" : ""}
        </Badge>
      </div>
      <div className="space-y-2 pl-2 border-l border-border/60">
        {containers.map((container) => (
          <ContainerCard
            key={container.id}
            container={container}
            orgId={orgId}
            onImport={onImport}
          />
        ))}
      </div>
    </div>
  );
}

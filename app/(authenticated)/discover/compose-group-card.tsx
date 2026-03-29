"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContainerCard } from "./container-card";
import type { DiscoveredContainer } from "@/lib/docker/discover";

type ComposeGroupCardProps = {
  composeProject: string;
  containers: DiscoveredContainer[];
  onImport: (group: { composeProject: string; containers: DiscoveredContainer[] }) => void;
};

export function ComposeGroupCard({
  composeProject,
  containers,
  onImport,
}: ComposeGroupCardProps) {
  return (
    <div className="squircle border bg-card/50 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{composeProject}</span>
          <Badge variant="outline" className="text-xs">
            {containers.length} service{containers.length !== 1 ? "s" : ""}
          </Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          onClick={() => onImport({ composeProject, containers })}
          aria-label={`Import ${composeProject} stack`}
        >
          Import
        </Button>
      </div>
      <div className="space-y-2 pl-2 border-l border-border/60">
        {containers.map((container) => (
          <ContainerCard
            key={container.id}
            container={container}
          />
        ))}
      </div>
    </div>
  );
}

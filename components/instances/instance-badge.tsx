import { Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/** Marks an item that lives on another instance. */
export function InstanceBadge({ name }: { name: string }) {
  return (
    <Badge variant="outline" className="gap-1 px-1.5 py-0 shrink-0 font-normal" title={`On ${name}`}>
      <Server className="size-3" aria-hidden="true" />
      {name}
    </Badge>
  );
}

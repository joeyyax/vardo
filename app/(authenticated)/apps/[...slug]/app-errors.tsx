import { Bug } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

// The tab is the place for error signal; nothing feeds it yet.
export function AppErrors() {
  return (
    <EmptyState
      className="p-8"
      icon={Bug}
      title="Error tracking not configured"
      body="Nothing is collecting errors for this app."
    />
  );
}

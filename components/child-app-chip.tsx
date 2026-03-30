import { statusDotColor } from "@/lib/ui/status-colors";

export function ChildAppChip({
  displayName,
  status,
}: {
  displayName: string;
  status: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-xs font-medium bg-background">
      <span aria-hidden="true" className={`size-1.5 rounded-full ${statusDotColor(status)}`} />
      {displayName}
      <span className="sr-only">
        {status === "active" ? ", Running" : status === "error" ? ", Crashed" : status === "deploying" ? ", Deploying" : ", Stopped"}
      </span>
    </span>
  );
}

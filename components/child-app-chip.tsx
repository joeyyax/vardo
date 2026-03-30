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

export function ChildAppChipList({
  childApps,
}: {
  childApps: { id: string; displayName: string; status: string }[];
}) {
  if (childApps.length === 0) return null;
  return (
    <div className="relative flex flex-wrap gap-1.5 mt-3 pt-3 border-t">
      {childApps.map((child) => (
        <ChildAppChip key={child.id} displayName={child.displayName} status={child.status} />
      ))}
    </div>
  );
}

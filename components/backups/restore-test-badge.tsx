import { CheckCircle2, CircleDashed, ShieldAlert, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Term } from "@/components/term";
import { RelativeTime } from "@/components/relative-time";
import type { RestoreTest } from "./history-state";

/** Whether a backup has been proven restorable. */
export function RestoreTestBadge({ test }: { test: RestoreTest }) {
  switch (test.kind) {
    case "none":
      return <span className="text-muted-foreground">—</span>;
    case "verified":
      return (
        <div className="space-y-1" title={test.detail ?? undefined}>
          <Badge variant="success">
            <CheckCircle2 className="mr-1 size-3" aria-hidden="true" />
            <Term id="restore-drill">Restore verified</Term>
          </Badge>
          <div className="text-xs text-muted-foreground">
            <RelativeTime date={test.at} />
          </div>
        </div>
      );
    case "failed":
      return (
        <div className="max-w-64 space-y-1">
          <Badge variant="error">
            <XCircle className="mr-1 size-3" aria-hidden="true" />
            <Term id="restore-drill">Restore test failed</Term>
          </Badge>
          {test.detail && <p className="text-xs text-muted-foreground">{test.detail}</p>}
        </div>
      );
    case "unsupported":
      return (
        <div className="max-w-64 space-y-1">
          <Badge variant="neutral">
            <ShieldAlert className="mr-1 size-3" aria-hidden="true" />
            {"Can't be tested"}
          </Badge>
          {test.detail && <p className="text-xs text-muted-foreground">{test.detail}</p>}
        </div>
      );
    default:
      return (
        <Badge variant="neutral">
          <CircleDashed className="mr-1 size-3" aria-hidden="true" />
          <Term id="restore-drill">Not verified yet</Term>
        </Badge>
      );
  }
}

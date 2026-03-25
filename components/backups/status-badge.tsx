import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Loader2, Clock } from "lucide-react";

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "success":
      return (
        <Badge className="border-transparent bg-status-success-muted text-status-success">
          <CheckCircle2 className="mr-1 size-3" aria-hidden="true" />
          Success
        </Badge>
      );
    case "running":
      return (
        <Badge className="border-transparent bg-status-warning-muted text-status-warning">
          <Loader2 className="mr-1 size-3 animate-spin" aria-hidden="true" />
          Running
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 size-3" aria-hidden="true" />
          Failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline">
          <Clock className="mr-1 size-3" aria-hidden="true" />
          Pending
        </Badge>
      );
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

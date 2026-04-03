"use client";

import { useState, useCallback } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type Finding = {
  category: string;
  severity: "info" | "warning" | "critical";
  service: string | null;
  message: string;
  detail: Record<string, unknown>;
  autoFixed: boolean;
};

type ComposeAnalysis = {
  findings: Finding[];
  counts: Record<string, number>;
};

type ComposeReviewProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  composeContent: string;
  orgId: string;
  /** Called when the user acknowledges the findings and wants to proceed. */
  onProceed: () => void;
};

const severityIcon = {
  info: <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />,
  warning: <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />,
  critical: <ShieldAlert className="h-4 w-4 text-destructive shrink-0" />,
};

export function ComposeReview({
  open,
  onOpenChange,
  composeContent,
  orgId,
  onProceed,
}: ComposeReviewProps) {
  const [analysis, setAnalysis] = useState<ComposeAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = useCallback(() => {
    if (!composeContent) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);

    fetch(`/api/v1/organizations/${orgId}/compose/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composeContent }),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to analyze compose");
        return res.json();
      })
      .then(setAnalysis)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [composeContent, orgId]);

  const autoFixed = analysis?.findings.filter((f) => f.autoFixed) ?? [];
  const needsReview = analysis?.findings.filter((f) => !f.autoFixed && f.severity === "warning") ?? [];
  const envCandidates = analysis?.findings.filter(
    (f) => f.category === "inline-env" && !f.autoFixed && !f.detail.managed
  ) ?? [];

  const hasFindings = (analysis?.findings.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (v) fetchAnalysis(); onOpenChange(v); }}>
      <DialogContent className="squircle sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Compose Review</DialogTitle>
          <DialogDescription>
            {loading
              ? "Analyzing your compose file..."
              : hasFindings
                ? "Vardo will make the following adjustments for a smooth deploy."
                : "Your compose file looks good — no adjustments needed."}
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {analysis && !loading && (
          <div className="space-y-4 max-h-[60vh] overflow-y-auto">
            {/* Auto-fixed items */}
            {autoFixed.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                  Automatic adjustments
                  <Badge variant="secondary" className="text-xs">{autoFixed.length}</Badge>
                </h4>
                <div className="space-y-1">
                  {autoFixed.map((f, i) => (
                    <FindingRow key={i} finding={f} />
                  ))}
                </div>
              </div>
            )}

            {/* Warnings that need review */}
            {needsReview.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <AlertCircle className="h-4 w-4 text-amber-500" />
                  Needs review
                  <Badge variant="outline" className="text-xs">{needsReview.length}</Badge>
                </h4>
                <div className="space-y-1">
                  {needsReview.map((f, i) => (
                    <FindingRow key={i} finding={f} />
                  ))}
                </div>
              </div>
            )}

            {/* Env var extraction candidates */}
            {envCandidates.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-2">
                  <Info className="h-4 w-4 text-blue-500" />
                  Environment variables
                  <Badge variant="outline" className="text-xs">{envCandidates.length}</Badge>
                </h4>
                <p className="text-xs text-muted-foreground">
                  These inline values can be managed as encrypted Vardo env vars after deploy.
                </p>
                <div className="space-y-1">
                  {envCandidates.map((f, i) => (
                    <FindingRow key={i} finding={f} />
                  ))}
                </div>
              </div>
            )}

            {!hasFindings && (
              <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                <CheckCircle2 className="h-4 w-4" />
                No adjustments needed — compose is ready to deploy.
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              onProceed();
            }}
            disabled={loading}
          >
            {hasFindings ? "Deploy with adjustments" : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
      {severityIcon[finding.severity]}
      <div className="min-w-0">
        <p className="text-sm">{finding.message}</p>
        {finding.service && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Service: <code className="font-mono">{finding.service}</code>
          </p>
        )}
      </div>
    </div>
  );
}

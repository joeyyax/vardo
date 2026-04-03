"use client";

import { useState, useCallback } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/messenger";

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
  /** App ID — when provided, enables interactive env var extraction. */
  appId?: string;
  /** Called when the user acknowledges the findings and wants to proceed. */
  onProceed: () => void;
};

const severityIcon: Record<Finding["severity"], React.ReactNode> = {
  info: <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />,
  warning: <AlertCircle className="h-4 w-4 text-amber-500 shrink-0" />,
  critical: <AlertCircle className="h-4 w-4 text-destructive shrink-0" />,
};

export function ComposeReview({
  open,
  onOpenChange,
  composeContent,
  orgId,
  appId,
  onProceed,
}: ComposeReviewProps) {
  const [analysis, setAnalysis] = useState<ComposeAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEnvKeys, setSelectedEnvKeys] = useState<Set<string>>(new Set());
  const [extracting, setExtracting] = useState(false);

  const fetchAnalysis = useCallback(() => {
    if (!composeContent) return;
    setLoading(true);
    setError(null);
    setAnalysis(null);
    setSelectedEnvKeys(new Set());

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

  function toggleEnvKey(key: string) {
    setSelectedEnvKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllEnvKeys() {
    if (selectedEnvKeys.size === envCandidates.length) {
      setSelectedEnvKeys(new Set());
    } else {
      setSelectedEnvKeys(new Set(envCandidates.map((f) => f.detail.key as string)));
    }
  }

  async function extractAndProceed() {
    if (selectedEnvKeys.size > 0 && appId) {
      setExtracting(true);
      try {
        // Get current env content
        const getRes = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/env-vars?reveal=true`,
        );
        const { content: currentContent } = await getRes.json();

        // Build new lines from selected candidates
        const newLines = envCandidates
          .filter((f) => selectedEnvKeys.has(f.detail.key as string))
          .map((f) => `${f.detail.key}=${f.detail.value}`);

        // Append to existing content
        const separator = currentContent && !currentContent.endsWith("\n") ? "\n" : "";
        const updated = (currentContent || "") + separator + newLines.join("\n") + "\n";

        // Save back
        const putRes = await fetch(
          `/api/v1/organizations/${orgId}/apps/${appId}/env-vars`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: updated }),
          },
        );

        if (!putRes.ok) throw new Error("Failed to save env vars");
        toast.success(`Imported ${newLines.length} env var${newLines.length > 1 ? "s" : ""}`);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to import env vars");
      } finally {
        setExtracting(false);
      }
    }

    onOpenChange(false);
    onProceed();
  }

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
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-medium flex items-center gap-2">
                    <Info className="h-4 w-4 text-blue-500" />
                    Environment variables
                    <Badge variant="outline" className="text-xs">{envCandidates.length}</Badge>
                  </h4>
                  {appId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-6"
                      onClick={selectAllEnvKeys}
                    >
                      {selectedEnvKeys.size === envCandidates.length ? "Deselect all" : "Select all"}
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {appId
                    ? "Select variables to import as encrypted Vardo env vars."
                    : "These inline values can be managed as encrypted Vardo env vars after deploy."}
                </p>
                <div className="space-y-1">
                  {envCandidates.map((f, i) => (
                    <EnvFindingRow
                      key={i}
                      finding={f}
                      selectable={!!appId}
                      selected={selectedEnvKeys.has(f.detail.key as string)}
                      onToggle={() => toggleEnvKey(f.detail.key as string)}
                    />
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
            onClick={extractAndProceed}
            disabled={loading || extracting}
          >
            {extracting ? (
              <><Loader2 className="mr-2 size-4 animate-spin" />Importing...</>
            ) : selectedEnvKeys.size > 0 ? (
              `Import ${selectedEnvKeys.size} var${selectedEnvKeys.size > 1 ? "s" : ""} & deploy`
            ) : hasFindings ? (
              "Deploy with adjustments"
            ) : (
              "Deploy"
            )}
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

function EnvFindingRow({
  finding,
  selectable,
  selected,
  onToggle,
}: {
  finding: Finding;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={selectable ? onToggle : undefined}
    >
      {selectable ? (
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          className="mt-0.5 shrink-0"
        />
      ) : (
        <Info className="h-4 w-4 text-blue-500 shrink-0" />
      )}
      <div className="min-w-0">
        <p className="text-sm font-mono">{finding.detail.key as string}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {finding.detail.value as string}
        </p>
      </div>
    </div>
  );
}

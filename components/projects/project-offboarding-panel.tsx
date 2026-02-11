"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  CheckCircle2,
  Download,
  HelpCircle,
  Loader2,
  PackageOpen,
  ChevronDown,
  ChevronRight,
  Clock,
  CircleDot,
  Check,
  X,
} from "lucide-react";
import {
  MIGRATION_CHECKLIST_PHASES,
  MIGRATION_ASSISTANCE_TIERS,
  DATA_EXPORT_CONTENTS,
} from "@/lib/offboarding-templates";
import type { DataExportStatus } from "@/lib/db/schema";

type ExportRequest = {
  id: string;
  status: DataExportStatus;
  requestedAt: string;
  completedAt: string | null;
  includes: { code: boolean; database: boolean; media: boolean } | null;
};

type ProjectOffboardingPanelProps = {
  orgId: string;
  projectId: string;
  onComplete: () => void;
};

export function ProjectOffboardingPanel({
  orgId,
  projectId,
  onComplete,
}: ProjectOffboardingPanelProps) {
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null);
  const [isLoadingExport, setIsLoadingExport] = useState(true);
  const [isRequesting, setIsRequesting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());

  const fetchExportStatus = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/offboarding/export`
      );
      if (res.ok) {
        const data = await res.json();
        setExportRequest(data.export);
      }
    } catch (err) {
      console.error("Error fetching export status:", err);
    } finally {
      setIsLoadingExport(false);
    }
  }, [orgId, projectId]);

  useEffect(() => {
    fetchExportStatus();
  }, [fetchExportStatus]);

  const requestExport = async () => {
    setIsRequesting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/offboarding/export`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: true, database: true, media: true }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        setExportRequest(data.export);
        toast.success("Data export requested", {
          description: "You'll be notified when the export is ready.",
        });
      } else if (res.status === 409) {
        toast.error("An export is already in progress");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to request export");
      }
    } catch (err) {
      console.error("Error requesting export:", err);
      toast.error("Something went wrong");
    } finally {
      setIsRequesting(false);
    }
  };

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/offboarding/complete`,
        { method: "POST" }
      );

      if (res.ok) {
        toast.success("Offboarding complete", {
          description: "The project has been archived.",
        });
        onComplete();
      } else {
        const data = await res.json();
        toast.error("Cannot complete offboarding", {
          description: data.error,
        });
      }
    } catch (err) {
      console.error("Error completing offboarding:", err);
      toast.error("Something went wrong");
    } finally {
      setIsCompleting(false);
    }
  };

  const togglePhase = (phaseId: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phaseId)) {
        next.delete(phaseId);
      } else {
        next.add(phaseId);
      }
      return next;
    });
  };

  const exportStatusLabel: Record<DataExportStatus, string> = {
    requested: "Requested",
    processing: "Processing",
    ready: "Ready",
    expired: "Expired",
  };

  const exportStatusColor: Record<DataExportStatus, string> = {
    requested: "text-amber-600 dark:text-amber-400",
    processing: "text-blue-600 dark:text-blue-400",
    ready: "text-green-600 dark:text-green-400",
    expired: "text-muted-foreground",
  };

  return (
    <div className="space-y-6">
      {/* Data Export */}
      <Card className="squircle">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Download className="size-5" />
            Request Application Data
          </CardTitle>
          {exportRequest && (
            <div className="flex items-center gap-2">
              <CircleDot className={`size-3 ${exportStatusColor[exportRequest.status]}`} />
              <span className={`text-sm font-medium ${exportStatusColor[exportRequest.status]}`}>
                {exportStatusLabel[exportRequest.status]}
              </span>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Export your application data including source code, database backup, and media files.
            This is always available during and after offboarding.
          </p>

          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <Check className="size-3.5 text-green-600" />
                Included
              </h4>
              <ul className="space-y-1">
                {DATA_EXPORT_CONTENTS.included.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h4 className="text-sm font-medium mb-2 flex items-center gap-1.5">
                <X className="size-3.5 text-muted-foreground" />
                Not included
              </h4>
              <ul className="space-y-1">
                {DATA_EXPORT_CONTENTS.excluded.map((item) => (
                  <li key={item} className="text-sm text-muted-foreground">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {isLoadingExport ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading export status...
            </div>
          ) : !exportRequest || exportRequest.status === "expired" ? (
            <Button
              onClick={requestExport}
              disabled={isRequesting}
              className="squircle"
            >
              {isRequesting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              Request Data Export
            </Button>
          ) : exportRequest.status === "ready" ? (
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle2 className="size-4" />
                Export is ready
              </div>
              <Button
                onClick={requestExport}
                disabled={isRequesting}
                variant="outline"
                size="sm"
                className="squircle"
              >
                Request New Export
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <Clock className="size-4 text-muted-foreground" />
              <span className="text-muted-foreground">
                Export {exportRequest.status === "processing" ? "is being prepared" : "has been requested"}.
                You&apos;ll be notified when it&apos;s ready.
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Migration Checklist */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PackageOpen className="size-5" />
            Migration Checklist
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground mb-4">
            A guide for moving your project to a new environment. These steps are
            informational — work through them at your own pace.
          </p>

          {MIGRATION_CHECKLIST_PHASES.map((phase) => {
            const isExpanded = expandedPhases.has(phase.id);
            return (
              <div key={phase.id} className="border rounded-lg">
                <button
                  type="button"
                  onClick={() => togglePhase(phase.id)}
                  className="flex items-center gap-3 w-full p-3 text-left hover:bg-accent/50 transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm">{phase.title}</span>
                    {!isExpanded && (
                      <span className="text-xs text-muted-foreground ml-2">
                        {phase.items.length} items
                      </span>
                    )}
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-3 pb-3 pl-10 space-y-2">
                    <p className="text-sm text-muted-foreground">{phase.description}</p>
                    <ul className="space-y-1.5">
                      {phase.items.map((item, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm">
                          <span className="text-muted-foreground mt-0.5 shrink-0">•</span>
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Migration Assistance */}
      <Card className="squircle">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HelpCircle className="size-5" />
            Migration Assistance
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Migration assistance is optional. Most clients handle the transition on their own
            using the export and checklist above. If you need help, these options are available.
          </p>

          <div className="grid gap-4 sm:grid-cols-3">
            {MIGRATION_ASSISTANCE_TIERS.map((tier) => (
              <div
                key={tier.id}
                className="border rounded-lg p-4 space-y-3"
              >
                <div>
                  <h4 className="font-medium text-sm">{tier.name}</h4>
                  <p className="text-xs text-muted-foreground mt-1">
                    {tier.description}
                  </p>
                </div>

                <div>
                  <p className="text-xs font-medium mb-1.5">Includes:</p>
                  <ul className="space-y-1">
                    {tier.included.map((item) => (
                      <li key={item} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                        <Check className="size-3 shrink-0 mt-0.5 text-green-600" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="pt-2 border-t">
                  <span className="text-xs font-medium">{tier.pricing}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Complete Offboarding */}
      <Card className="squircle border-dashed">
        <CardContent className="py-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-medium">Complete Offboarding</h3>
              <p className="text-sm text-muted-foreground mt-1">
                When you&apos;re finished with the transition, mark the project as complete.
                This archives the project but preserves all data.
              </p>
            </div>
            <Button
              onClick={handleComplete}
              disabled={isCompleting}
              className="squircle shrink-0"
            >
              {isCompleting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              Mark Complete
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

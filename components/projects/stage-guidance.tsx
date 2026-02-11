"use client";

import { useState, useEffect, useRef } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Send,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { eventBus } from "@/lib/events";
import { FORWARD_STAGE_TRANSITIONS, type ProjectStage } from "@/lib/db/schema";
import type { DocumentContent } from "@/lib/template-engine/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Document = {
  id: string;
  type: "proposal" | "contract" | "change_order" | "orientation";
  status: "draft" | "sent" | "viewed" | "accepted" | "declined";
  title: string;
  content: DocumentContent;
  publicToken: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  createdAt: string;
};

type StageGuidanceProps = {
  stage: ProjectStage;
  projectId: string;
  orgId: string;
  projectName: string;
  clientName: string;
  organizationName: string;
  documents: Document[];
  hasActiveTasks?: boolean;
  onStageAdvanced: () => void;
  onDocumentAction: (type: "proposal" | "contract" | "change_order", suggestedTemplateId?: string) => void;
};

// Map accepted proposal pricing type → suggested contract starter template id
const PRICING_TO_CONTRACT: Record<string, string> = {
  hourly: "hourly-contract",
  retainer: "retainer-contract",
  fixed: "fixed-scope-contract",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STAGE_ORDER: ProjectStage[] = [
  "getting_started",
  "proposal",
  "agreement",
  "onboarding",
  "active",
  "ongoing",
  "offboarding",
  "completed",
];

function computeEffectiveStage(
  dbStage: ProjectStage,
  docs: Document[]
): ProjectStage {
  const proposals = docs.filter((d) => d.type === "proposal");
  const contracts = docs.filter((d) => d.type === "contract");
  const hasAcceptedProposal = proposals.some((d) => d.status === "accepted");
  const hasAnyProposal = proposals.length > 0;
  const hasAnyContract = contracts.length > 0;

  const dbIndex = STAGE_ORDER.indexOf(dbStage);
  let effective = dbStage;
  let effectiveIndex = dbIndex;

  if (hasAnyProposal && effectiveIndex < STAGE_ORDER.indexOf("proposal")) {
    effective = "proposal";
    effectiveIndex = STAGE_ORDER.indexOf("proposal");
  }
  if (
    (hasAcceptedProposal || hasAnyContract) &&
    effectiveIndex < STAGE_ORDER.indexOf("agreement")
  ) {
    effective = "agreement";
  }

  return effective;
}

function countByStatus(docs: Document[], type: string) {
  const filtered = docs.filter((d) => d.type === type);
  return {
    total: filtered.length,
    draft: filtered.filter((d) => d.status === "draft").length,
    sent: filtered.filter((d) => d.status === "sent" || d.status === "viewed").length,
    accepted: filtered.filter((d) => d.status === "accepted").length,
    declined: filtered.filter((d) => d.status === "declined").length,
  };
}

function getAcceptedProposalPricingType(docs: Document[]): string | null {
  const accepted = docs.find(
    (d) => d.type === "proposal" && d.status === "accepted"
  );
  if (!accepted?.content?.pricing?.type) return null;
  return accepted.content.pricing.type;
}

// ---------------------------------------------------------------------------
// Stage Steps Overview
// ---------------------------------------------------------------------------

const STAGE_STEPS: { stage: ProjectStage; label: string }[] = [
  { stage: "proposal", label: "Proposal" },
  { stage: "agreement", label: "Agreement" },
  { stage: "onboarding", label: "Onboarding" },
  { stage: "active", label: "Active" },
];

function StepOverview({ currentStage }: { currentStage: ProjectStage }) {
  const stageOrder: ProjectStage[] = [
    "getting_started",
    "proposal",
    "agreement",
    "onboarding",
    "active",
  ];
  const currentIndex = stageOrder.indexOf(currentStage);

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground mt-3">
      {STAGE_STEPS.map((step, i) => {
        const stepIndex = stageOrder.indexOf(step.stage);
        const isDone = stepIndex < currentIndex;
        const isCurrent = step.stage === currentStage;

        return (
          <div key={step.stage} className="flex items-center gap-2">
            {i > 0 && (
              <div
                className={`h-px w-4 ${
                  isDone ? "bg-primary" : "bg-border"
                }`}
              />
            )}
            <span
              className={
                isDone
                  ? "text-primary font-medium"
                  : isCurrent
                    ? "text-foreground font-medium"
                    : ""
              }
            >
              {isDone && <CheckCircle2 className="size-3 inline mr-0.5" />}
              {step.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StageGuidance({
  stage,
  projectId,
  orgId,
  projectName,
  clientName,
  organizationName,
  documents,
  hasActiveTasks = false,
  onStageAdvanced,
  onDocumentAction,
}: StageGuidanceProps) {
  const [isAdvancing, setIsAdvancing] = useState(false);
  const [docs, setDocs] = useState(documents);

  // Keep in sync when parent re-renders with new documents
  useEffect(() => {
    setDocs(documents);
  }, [documents]);

  // Subscribe to document status changes to refetch
  useEffect(() => {
    const unsub = eventBus.on("document:status:changed", (payload) => {
      if (payload.projectId === projectId) {
        // Trigger parent refetch via stage advanced callback
        onStageAdvanced();
      }
    });
    return unsub;
  }, [projectId, onStageAdvanced]);

  // Compute effective stage from document state
  const effectiveStage = computeEffectiveStage(stage, docs);

  // Auto-sync the DB stage when effective stage is ahead
  const syncingRef = useRef(false);
  useEffect(() => {
    if (effectiveStage === stage || syncingRef.current) return;

    const dbIndex = STAGE_ORDER.indexOf(stage);
    const targetIndex = STAGE_ORDER.indexOf(effectiveStage);
    if (targetIndex <= dbIndex) return;

    // Walk through valid transitions one step at a time
    async function syncStage() {
      syncingRef.current = true;
      let current = stage;
      try {
        while (STAGE_ORDER.indexOf(current) < targetIndex) {
          const allowed = FORWARD_STAGE_TRANSITIONS[current];
          const nextIndex = STAGE_ORDER.indexOf(current) + 1;
          const next = STAGE_ORDER[nextIndex];
          if (!next || !allowed.includes(next)) break;

          const res = await fetch(
            `/api/v1/organizations/${orgId}/projects/${projectId}`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ stage: next }),
            }
          );
          if (!res.ok) break;
          current = next;
        }
        if (current !== stage) {
          eventBus.emit("project:stage:changed", {
            projectId,
            newStage: current,
          });
          onStageAdvanced();
        }
      } finally {
        syncingRef.current = false;
      }
    }

    syncStage();
  }, [effectiveStage, stage, orgId, projectId, onStageAdvanced]);

  async function advanceStage(nextStage: ProjectStage) {
    setIsAdvancing(true);
    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ stage: nextStage }),
        }
      );

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to advance stage");
      }

      toast.success(`Advanced to ${nextStage.replace(/_/g, " ")}`);
      eventBus.emit("project:stage:changed", {
        projectId,
        newStage: nextStage,
      });
      onStageAdvanced();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to advance stage"
      );
    } finally {
      setIsAdvancing(false);
    }
  }

  // Don't render for active/ongoing/offboarding/completed
  if (
    effectiveStage === "active" ||
    effectiveStage === "ongoing" ||
    effectiveStage === "offboarding" ||
    effectiveStage === "completed"
  ) {
    return null;
  }

  // Pre-active stages with active tasks → show warning
  const preActiveWarning = hasActiveTasks && STAGE_ORDER.indexOf(effectiveStage) < STAGE_ORDER.indexOf("active");

  // Helper: wrap stage content with an "unapproved work" warning if needed
  function withWarning(content: React.ReactNode) {
    if (!preActiveWarning) return content;
    return (
      <div className="space-y-3">
        <Card className="squircle border-amber-300 dark:border-amber-700 bg-amber-50/80 dark:bg-amber-950/30">
          <CardContent className="py-3 px-5">
            <div className="flex items-center gap-2.5">
              <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-200">
                This project has active tasks but hasn&apos;t been formally approved yet.
                Advance to <strong>Active</strong> when ready to begin work.
              </p>
            </div>
          </CardContent>
        </Card>
        {content}
      </div>
    );
  }

  // ------ GETTING STARTED ------
  if (effectiveStage === "getting_started") {
    return withWarning(
      <Card className="squircle border-blue-200 dark:border-blue-800/50 bg-blue-50/50 dark:bg-blue-950/20">
        <CardContent className="py-5 px-6">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900">
              <Sparkles className="size-4 text-blue-600 dark:text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">
                Welcome to your new project
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Start by creating a proposal to define scope and pricing for{" "}
                <strong>{clientName}</strong>. Once the proposal is accepted,
                you&apos;ll move through agreement and onboarding before work
                begins.
              </p>
              <StepOverview currentStage={effectiveStage} />
              <div className="mt-4">
                <Button
                  size="sm"
                  className="squircle"
                  onClick={() => onDocumentAction("proposal")}
                >
                  <FileText className="size-4" />
                  Create Proposal
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ------ PROPOSAL ------
  if (effectiveStage === "proposal") {
    const proposals = countByStatus(docs, "proposal");

    // No proposals yet
    if (proposals.total === 0) {
      return withWarning(
        <Card className="squircle border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900">
                <FileText className="size-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Create a proposal to get started
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Define your scope, deliverables, and pricing for{" "}
                  <strong>{clientName}</strong>.
                </p>
                <div className="mt-4">
                  <Button
                    size="sm"
                    className="squircle"
                    onClick={() => onDocumentAction("proposal")}
                  >
                    <FileText className="size-4" />
                    Create Proposal
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Has drafts but nothing sent
    if (proposals.draft > 0 && proposals.sent === 0 && proposals.accepted === 0) {
      return withWarning(
        <Card className="squircle border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900">
                <Send className="size-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Send your proposal to the client
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  You have {proposals.draft} draft{" "}
                  {proposals.draft === 1 ? "proposal" : "proposals"} ready.
                  Open it to review and send to{" "}
                  <strong>{clientName}</strong>.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Sent, waiting for response
    if (proposals.sent > 0 && proposals.accepted === 0) {
      return withWarning(
        <Card className="squircle border-amber-200 dark:border-amber-800/50 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900">
                <Clock className="size-4 text-amber-600 dark:text-amber-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Waiting for {clientName} to respond
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Your proposal has been sent. You&apos;ll see their response
                  here once they review it.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Accepted — can advance
    if (proposals.accepted > 0) {
      return withWarning(
        <Card className="squircle border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Proposal accepted
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  <strong>{clientName}</strong> has accepted your proposal.
                  Advance to the agreement stage to formalize the engagement
                  with a contract.
                </p>
                <div className="mt-4">
                  <Button
                    size="sm"
                    className="squircle"
                    onClick={() => advanceStage("agreement")}
                    disabled={isAdvancing}
                  >
                    {isAdvancing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                    Advance to Agreement
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    return null;
  }

  // ------ AGREEMENT ------
  if (effectiveStage === "agreement") {
    const contracts = countByStatus(docs, "contract");
    const pricingType = getAcceptedProposalPricingType(docs);
    const suggestedContractId = pricingType
      ? PRICING_TO_CONTRACT[pricingType] || null
      : null;

    // No contracts yet — suggest creating one
    if (contracts.total === 0) {
      return withWarning(
        <Card className="squircle border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900">
                <FileText className="size-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Formalize with a contract
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Create a service agreement to formalize the engagement with{" "}
                  <strong>{clientName}</strong> before work begins.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <Button
                    size="sm"
                    className="squircle"
                    onClick={() =>
                      onDocumentAction(
                        "contract",
                        suggestedContractId || undefined
                      )
                    }
                  >
                    <FileText className="size-4" />
                    Create Contract
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="squircle"
                    onClick={() => advanceStage("onboarding")}
                    disabled={isAdvancing}
                  >
                    {isAdvancing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                    Skip to Onboarding
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Draft contracts
    if (contracts.draft > 0 && contracts.sent === 0 && contracts.accepted === 0) {
      return withWarning(
        <Card className="squircle border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900">
                <Send className="size-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Send your contract for review
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Open the contract to review and send to{" "}
                  <strong>{clientName}</strong> for acceptance.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Sent, waiting
    if (contracts.sent > 0 && contracts.accepted === 0) {
      return withWarning(
        <Card className="squircle border-violet-200 dark:border-violet-800/50 bg-violet-50/50 dark:bg-violet-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-900">
                <Clock className="size-4 text-violet-600 dark:text-violet-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Waiting for {clientName} to accept
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  The contract has been sent. You&apos;ll see their response
                  here once they review it.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Contract accepted — advance
    if (contracts.accepted > 0) {
      return withWarning(
        <Card className="squircle border-emerald-200 dark:border-emerald-800/50 bg-emerald-50/50 dark:bg-emerald-950/20">
          <CardContent className="py-5 px-6">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
                <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm">
                  Contract accepted
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  The agreement is in place. Advance to onboarding to gather
                  access and assets before work begins.
                </p>
                <div className="mt-4">
                  <Button
                    size="sm"
                    className="squircle"
                    onClick={() => advanceStage("onboarding")}
                    disabled={isAdvancing}
                  >
                    {isAdvancing ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <ArrowRight className="size-4" />
                    )}
                    Advance to Onboarding
                  </Button>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      );
    }

    return null;
  }

  // ------ ONBOARDING ------
  if (effectiveStage === "onboarding") {
    return withWarning(
      <Card className="squircle border-cyan-200 dark:border-cyan-800/50 bg-cyan-50/50 dark:bg-cyan-950/20">
        <CardContent className="py-5 px-6">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan-100 dark:bg-cyan-900">
              <Sparkles className="size-4 text-cyan-600 dark:text-cyan-400" />
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-sm">
                Gather everything you need before work begins
              </h3>
              <p className="text-sm text-muted-foreground mt-1">
                Use the onboarding checklist below to collect credentials,
                access, and assets from <strong>{clientName}</strong>.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}

"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SectionTiptapEditor } from "./section-tiptap-editor";
import { cn } from "@/lib/utils";
import {
  substituteVariables,
  buildVariableMap,
  markdownToHtml,
  buildPricingFromConfig,
} from "@/lib/template-engine";
import type {
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  RenderedSection,
  DocumentContent,
  RenderContext,
} from "@/lib/template-engine/types";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  Lock,
  Pencil,
  FormInput,
  Save,
  Send,
  FileText,
  MoreHorizontal,
  Download,
  MailCheck,
  CheckCircle2,
  XCircle,
  Link2,
  RotateCcw,
} from "lucide-react";
import {
  DocumentCanvas,
  SectionModeIcon,
} from "./document-canvas";
import { nanoid } from "nanoid";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { format } from "date-fns";
import { CalendarIcon } from "lucide-react";
import { CurrencyInput } from "@/components/ui/currency-input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DocumentBuilderProps = {
  title: string;
  templateSections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig?: TemplatePricingConfig | null;
  templateLabel?: string;
  templateName?: string;
  context: RenderContext;
  initialVariableValues?: Record<string, string>;
  initialTitle?: string;
  readOnly?: boolean;
  status?: string;
  preRenderedHtml?: Record<string, string>;
  orgId?: string;
  projectId?: string;
  documentId?: string;
  onSave?: (data: {
    title: string;
    content: DocumentContent;
    variableValues: Record<string, string>;
  }) => Promise<void>;
  onSend?: (data: {
    title: string;
    content: DocumentContent;
    variableValues: Record<string, string>;
    recipientEmail?: string;
  }) => Promise<void>;
  initialSendEmail?: string;
  onStatusChange?: (newStatus: string, reason?: string) => Promise<void>;
  onBack?: () => void;
  publicToken?: string | null;
  sentAt?: string | null;
  viewedAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  acceptedBy?: string | null;
  declinedBy?: string | null;
  declineReason?: string | null;
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentBuilder({
  title: initialTitleProp,
  templateSections,
  variableSchema,
  pricingConfig,
  templateLabel,
  templateName,
  context,
  initialVariableValues = {},
  readOnly = false,
  status,
  preRenderedHtml,
  orgId,
  projectId,
  documentId,
  onSave,
  onSend,
  initialSendEmail,
  onStatusChange,
  onBack,
  publicToken,
  sentAt,
  acceptedAt,
  declinedAt,
  acceptedBy,
  declinedBy,
  declineReason,
}: DocumentBuilderProps) {
  const [documentTitle, setDocumentTitle] = useState(initialTitleProp || "");
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [variableValues, setVariableValues] = useState<Record<string, string>>(
    () => {
      // Initialize with defaults from schema
      const defaults: Record<string, string> = {};
      for (const v of variableSchema) {
        if (v.defaultValue !== undefined) {
          defaults[v.key] = v.defaultValue;
        }
      }
      return { ...defaults, ...initialVariableValues };
    }
  );
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);
  const [showSendDialog, setShowSendDialog] = useState(false);
  const [sendEmail, setSendEmail] = useState(initialSendEmail || "");

  // Build the rendered sections for the canvas preview
  const vars = useMemo(
    () => buildVariableMap(variableSchema, variableValues, context),
    [variableSchema, variableValues, context]
  );

  const renderedSections: RenderedSection[] = useMemo(() => {
    return templateSections
      .sort((a, b) => a.order - b.order)
      .map((section) => {
        let visible = true;
        if (section.visibilityVar) {
          const toggleValue = variableValues[section.visibilityVar];
          visible = toggleValue === "true" || toggleValue === "1";
        }

        let content: string;
        if (section.mode === "editable") {
          const richtextVar = variableSchema.find(
            (v) => v.type === "richtext" && v.section === section.key
          );
          content = richtextVar
            ? (variableValues[richtextVar.key] ?? "")
            : substituteVariables(section.body, vars);
        } else if (preRenderedHtml?.[section.key]) {
          // Already-rendered HTML from stored document content — don't re-process
          content = preRenderedHtml[section.key];
        } else {
          const substituted = substituteVariables(section.body, vars);
          content = markdownToHtml(substituted);
        }

        return {
          id: nanoid(8),
          key: section.key,
          title: substituteVariables(section.title, vars),
          content,
          mode: section.mode,
          order: section.order,
          visible,
        };
      });
  }, [templateSections, variableSchema, variableValues, vars]);

  const updateVariable = useCallback((key: string, value: string) => {
    setVariableValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const buildDocumentContent = useCallback((): DocumentContent => {
    return {
      sections: renderedSections,
      pricing: buildPricingFromConfig(pricingConfig, vars),
      // Preserve template metadata so the builder works without a templateId FK
      templateSections,
      variableSchema,
      pricingConfig: pricingConfig ?? undefined,
      templateName,
      templateLabel,
    };
  }, [renderedSections, pricingConfig, vars, templateSections, variableSchema, templateName, templateLabel]);

  const handleSave = useCallback(async () => {
    if (!onSave) return;
    setSaving(true);
    try {
      await onSave({
        title: documentTitle,
        content: buildDocumentContent(),
        variableValues,
      });
      setHasSaved(true);
    } finally {
      setSaving(false);
    }
  }, [onSave, documentTitle, buildDocumentContent, variableValues]);

  const handleSend = useCallback(async (recipientEmail?: string) => {
    if (!onSend) return;
    setSending(true);
    try {
      await onSend({
        title: documentTitle,
        content: buildDocumentContent(),
        variableValues,
        recipientEmail,
      });
    } finally {
      setSending(false);
    }
  }, [onSend, documentTitle, buildDocumentContent, variableValues]);

  // Wizard steps: only interactive sections (editable + form-driven)
  const steps = useMemo(() => {
    return templateSections
      .filter((s) => s.mode === "editable" || s.mode === "form-driven")
      .sort((a, b) => a.order - b.order);
  }, [templateSections]);

  const currentStep = steps[currentStepIndex] || null;
  const isLastStep = currentStepIndex === steps.length - 1;
  const progressPercent = steps.length > 0
    ? Math.round(((currentStepIndex + 1) / steps.length) * 100)
    : 0;

  // Variables scoped to the current step's section
  const stepVariables = useMemo(() => {
    if (!currentStep) return [];
    return variableSchema.filter(
      (v) => v.section === currentStep.key && v.type !== "richtext" && !v.source
    );
  }, [currentStep, variableSchema]);

  // Boolean toggle variables (for section visibility)
  const toggleVariables = useMemo(() => {
    return variableSchema.filter((v) => v.type === "boolean");
  }, [variableSchema]);

  // Check completion for a given step
  const isStepComplete = useCallback(
    (step: TemplateSection) => {
      if (step.mode === "editable") {
        const richtextVar = variableSchema.find(
          (v) => v.type === "richtext" && v.section === step.key
        );
        return !!(richtextVar && variableValues[richtextVar.key]?.trim());
      }
      if (step.mode === "form-driven") {
        const sectionVars = variableSchema.filter(
          (v) => v.section === step.key && v.type !== "richtext" && !v.source
        );
        return (
          sectionVars.length > 0 &&
          sectionVars.every((v) => !v.required || variableValues[v.key]?.trim())
        );
      }
      return false;
    },
    [variableSchema, variableValues]
  );

  // Scroll canvas to current section when step changes
  useEffect(() => {
    if (!currentStep || readOnly) return;
    const el = document.getElementById(`section-${currentStep.key}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [currentStepIndex, currentStep, readOnly]);

  // Read-only mode — just show the canvas
  if (readOnly) {
    return (
      <div className="flex flex-col h-full">
        <BuilderHeader
          title={documentTitle}
          templateLabel={templateLabel}
          status={status}
          readOnly
          onBack={onBack}
          onStatusChange={onStatusChange}
          publicToken={publicToken}
          sentAt={sentAt}
          acceptedAt={acceptedAt}
          declinedAt={declinedAt}
          acceptedBy={acceptedBy}
          declinedBy={declinedBy}
          declineReason={declineReason}
          orgId={orgId}
          projectId={projectId}
          documentId={documentId}
        />
        <div className="flex-1 overflow-y-auto p-6">
          <DocumentCanvas
            sections={renderedSections}
            selectedSection={null}
            onSelectSection={() => {}}
            readOnly
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <BuilderHeader
        title={documentTitle}
        templateLabel={templateLabel}
        templateName={templateName}
        status={status}
        onBack={onBack}
        onStatusChange={onStatusChange}
        saving={saving}
        sending={sending}
        publicToken={publicToken}
        orgId={orgId}
        projectId={projectId}
        documentId={documentId}
      />

      <div className="flex flex-1 min-h-0">
        {/* Left Panel — Wizard */}
        <div className="w-80 border-r overflow-y-auto bg-muted/20 flex flex-col">
          <div className="p-4 space-y-4 flex-1">
            {/* Progress indicator */}
            {steps.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">
                    Step {currentStepIndex + 1} of {steps.length}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {progressPercent}%
                  </span>
                </div>
                <Progress value={progressPercent} className="h-1.5" />
              </div>
            )}

            {/* Step dots — clickable navigation */}
            {steps.length > 1 && (
              <div className="flex items-center gap-1">
                {steps.map((step, idx) => {
                  const complete = isStepComplete(step);
                  const isCurrent = idx === currentStepIndex;
                  return (
                    <button
                      key={step.key}
                      onClick={() => setCurrentStepIndex(idx)}
                      className={cn(
                        "flex items-center justify-center size-6 rounded-full text-[10px] font-medium transition-colors",
                        isCurrent && "bg-primary text-primary-foreground",
                        !isCurrent && complete && "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
                        !isCurrent && !complete && "bg-muted text-muted-foreground hover:bg-accent"
                      )}
                      title={step.title}
                    >
                      {complete && !isCurrent ? (
                        <Check className="size-3" />
                      ) : (
                        idx + 1
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Document title — shown on first step */}
            {currentStepIndex === 0 && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="doc-title" className="text-xs font-medium text-muted-foreground">
                    Document Title
                  </Label>
                  <Input
                    id="doc-title"
                    value={documentTitle}
                    onChange={(e) => setDocumentTitle(e.target.value)}
                    placeholder="Untitled Document"
                  />
                </div>
                <Separator />
              </>
            )}

            {/* Current step content */}
            {currentStep && (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <SectionModeIcon mode={currentStep.mode} />
                  <span className="font-medium text-sm">
                    {currentStep.title}
                  </span>
                </div>

                {currentStep.mode === "editable" && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium text-muted-foreground">
                      Content
                    </Label>
                    {variableSchema
                      .filter(
                        (v) =>
                          v.type === "richtext" &&
                          v.section === currentStep.key
                      )
                      .map((v) => (
                        <SectionTiptapEditor
                          key={v.key}
                          content={variableValues[v.key] || ""}
                          onChange={(val) => updateVariable(v.key, val)}
                          placeholder={v.description || "Start writing..."}
                        />
                      ))}
                  </div>
                )}

                {currentStep.mode === "form-driven" &&
                  stepVariables.length > 0 && (
                    <div className="space-y-3">
                      {stepVariables.map((v) => (
                        <VariableField
                          key={v.key}
                          variable={v}
                          value={variableValues[v.key] || ""}
                          onChange={(val) => updateVariable(v.key, val)}
                        />
                      ))}
                    </div>
                  )}
              </div>
            )}

            {/* Section visibility toggles */}
            {toggleVariables.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Visibility
                  </Label>
                  {toggleVariables.map((v) => (
                    <div
                      key={v.key}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm">{v.label}</span>
                      <Switch
                        checked={variableValues[v.key] === "true"}
                        onCheckedChange={(checked) =>
                          updateVariable(v.key, checked ? "true" : "false")
                        }
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Navigation buttons — pinned to bottom */}
          <div className="border-t p-4 space-y-2">
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1"
                disabled={currentStepIndex === 0}
                onClick={() => setCurrentStepIndex((i) => Math.max(0, i - 1))}
              >
                <ChevronLeft className="size-3.5 mr-1" />
                Back
              </Button>

              {!isLastStep ? (
                <Button
                  size="sm"
                  className="flex-1"
                  onClick={() =>
                    setCurrentStepIndex((i) =>
                      Math.min(steps.length - 1, i + 1)
                    )
                  }
                >
                  Next
                  <ChevronRight className="size-3.5 ml-1" />
                </Button>
              ) : (
                <div className="flex-1 flex gap-2">
                  {onSave && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={handleSave}
                      disabled={saving || sending}
                    >
                      <Save className="size-3.5 mr-1" />
                      {saving ? "Saving..." : "Save"}
                    </Button>
                  )}
                  {onSend && hasSaved && (
                    <Button
                      size="sm"
                      className="flex-1"
                      onClick={() => setShowSendDialog(true)}
                      disabled={saving || sending}
                    >
                      <Send className="size-3.5 mr-1" />
                      Send
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Panel — Document Canvas */}
        <div ref={canvasRef} className="flex-1 overflow-y-auto bg-background">
          <div className="max-w-3xl mx-auto p-8">
            <DocumentCanvas
              sections={renderedSections}
              selectedSection={currentStep?.key || null}
              onSelectSection={(key) => {
                const idx = steps.findIndex((s) => s.key === key);
                if (idx >= 0) setCurrentStepIndex(idx);
              }}
            />
          </div>
        </div>
      </div>

      {/* Send confirmation dialog */}
      <Dialog open={showSendDialog} onOpenChange={setShowSendDialog}>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send Document</DialogTitle>
            <DialogDescription>
              Enter the recipient&apos;s email address to send this document.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="send-email">Recipient Email</Label>
            <Input
              id="send-email"
              type="email"
              value={sendEmail}
              onChange={(e) => setSendEmail(e.target.value)}
              placeholder="client@example.com"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSendDialog(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={async () => {
                await handleSend(sendEmail || undefined);
                setShowSendDialog(false);
              }}
              disabled={sending}
            >
              <Send className="size-3.5 mr-1" />
              {sending ? "Sending..." : "Confirm & Send"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const STATUS_BADGE_VARIANTS: Record<string, "outline" | "secondary" | "destructive"> = {
  draft: "outline",
  sent: "secondary",
  viewed: "secondary",
  accepted: "secondary",
  declined: "destructive",
};

function formatStatusDate(dateStr: string | null | undefined) {
  if (!dateStr) return null;
  try {
    return format(new Date(dateStr), "MMM d, yyyy");
  } catch {
    return null;
  }
}

function BuilderHeader({
  title,
  templateLabel,
  templateName,
  status,
  readOnly,
  onBack,
  onSave,
  onSend,
  onStatusChange,
  saving,
  sending,
  publicToken,
  sentAt,
  acceptedAt,
  declinedAt,
  acceptedBy,
  declinedBy,
  declineReason,
  orgId,
  projectId,
  documentId,
}: {
  title: string;
  templateLabel?: string;
  templateName?: string;
  status?: string;
  readOnly?: boolean;
  onBack?: () => void;
  onSave?: () => void;
  onSend?: () => void;
  onStatusChange?: (newStatus: string, reason?: string) => Promise<void>;
  saving?: boolean;
  sending?: boolean;
  publicToken?: string | null;
  sentAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  acceptedBy?: string | null;
  declinedBy?: string | null;
  declineReason?: string | null;
  orgId?: string;
  projectId?: string;
  documentId?: string;
}) {
  const [showDeclineDialog, setShowDeclineDialog] = useState(false);
  const [declineReasonInput, setDeclineReasonInput] = useState("");
  const [changingStatus, setChangingStatus] = useState(false);

  const handleStatusAction = useCallback(
    async (newStatus: string, reason?: string) => {
      if (!onStatusChange) return;
      setChangingStatus(true);
      try {
        await onStatusChange(newStatus, reason);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to update status");
      } finally {
        setChangingStatus(false);
      }
    },
    [onStatusChange]
  );

  const handleDeclineConfirm = useCallback(async () => {
    await handleStatusAction("declined", declineReasonInput || undefined);
    setShowDeclineDialog(false);
    setDeclineReasonInput("");
  }, [handleStatusAction, declineReasonInput]);

  const [downloading, setDownloading] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!orgId || !projectId || !documentId) {
      toast.error("Cannot download — document not yet saved");
      return;
    }
    setDownloading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${documentId}/pdf`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Download failed" }));
        throw new Error(err.error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${title || "document"}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }, [orgId, projectId, documentId, title]);

  const handleCopyPublicLink = useCallback(() => {
    if (!publicToken) return;
    const url = `${window.location.origin}/d/${publicToken}`;
    navigator.clipboard.writeText(url);
    toast.success("Public link copied to clipboard");
  }, [publicToken]);

  // Build status subtitle for tooltip
  let statusSubtitle = "";
  if (status === "sent" && sentAt) {
    statusSubtitle = `Sent on ${formatStatusDate(sentAt)}`;
  } else if (status === "accepted" && acceptedAt) {
    statusSubtitle = `Accepted${acceptedBy ? ` by ${acceptedBy}` : ""} on ${formatStatusDate(acceptedAt)}`;
  } else if (status === "declined" && declinedAt) {
    statusSubtitle = `Declined${declinedBy ? ` by ${declinedBy}` : ""} on ${formatStatusDate(declinedAt)}`;
    if (declineReason) statusSubtitle += ` — "${declineReason}"`;
  }

  return (
    <TooltipProvider>
      <div className="flex items-center justify-between border-b px-4 py-3 bg-muted/30 no-print">
        <div className="flex items-center gap-3">
          {onBack && (
            <Button variant="ghost" size="sm" onClick={onBack}>
              <ChevronLeft className="size-4 mr-1" />
              Back
            </Button>
          )}
          <div className="flex items-center gap-2">
            <FileText className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm truncate max-w-[300px]">
              {title || "Untitled Document"}
            </span>
            {templateLabel && (
              <Badge variant="secondary" className="text-xs">
                {templateLabel}
              </Badge>
            )}
            {!templateLabel && templateName && (
              <Badge variant="outline" className="text-xs">
                {templateName}
              </Badge>
            )}
            {status && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant={STATUS_BADGE_VARIANTS[status] || "outline"}
                    className="text-xs capitalize"
                  >
                    {status}
                  </Badge>
                </TooltipTrigger>
                {statusSubtitle && (
                  <TooltipContent>
                    <p className="text-xs">{statusSubtitle}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Actions dropdown */}
          {onStatusChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-8"
                  disabled={changingStatus}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* Download — always available */}
                <DropdownMenuItem onClick={handleDownload} disabled={downloading}>
                  <Download className="size-4 mr-2" />
                  {downloading ? "Downloading..." : "Download PDF"}
                </DropdownMenuItem>

                {/* Copy Public Link — available when sent/viewed/accepted/declined */}
                {publicToken && status !== "draft" && (
                  <DropdownMenuItem onClick={handleCopyPublicLink}>
                    <Link2 className="size-4 mr-2" />
                    Copy Public Link
                  </DropdownMenuItem>
                )}

                {/* Draft-specific actions */}
                {status === "draft" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => handleStatusAction("sent")}
                    >
                      <MailCheck className="size-4 mr-2" />
                      Mark as Sent
                    </DropdownMenuItem>
                  </>
                )}

                {/* Sent/Viewed actions */}
                {(status === "sent" || status === "viewed") && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => handleStatusAction("accepted")}
                    >
                      <CheckCircle2 className="size-4 mr-2" />
                      Mark as Accepted
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => setShowDeclineDialog(true)}
                    >
                      <XCircle className="size-4 mr-2" />
                      Mark as Declined
                    </DropdownMenuItem>
                  </>
                )}

                {/* Declined actions */}
                {status === "declined" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => handleStatusAction("draft")}
                    >
                      <RotateCcw className="size-4 mr-2" />
                      Revert to Draft
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Decline reason dialog */}
      <Dialog open={showDeclineDialog} onOpenChange={setShowDeclineDialog}>
        <DialogContent className="squircle sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark as Declined</DialogTitle>
            <DialogDescription>
              Optionally provide a reason for declining this document.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={declineReasonInput}
            onChange={(e) => setDeclineReasonInput(e.target.value)}
            placeholder="Reason (optional)"
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeclineDialog(false);
                setDeclineReasonInput("");
              }}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeclineConfirm}
              disabled={changingStatus}
            >
              {changingStatus ? "Updating..." : "Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Variable Field
// ---------------------------------------------------------------------------

function VariableField({
  variable,
  value,
  onChange,
}: {
  variable: TemplateVariable;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `var-${variable.key}`;

  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {variable.label}
        {variable.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>
      {variable.description && (
        <p className="text-[11px] text-muted-foreground">{variable.description}</p>
      )}

      {variable.type === "text" && (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={variable.label}
        />
      )}

      {variable.type === "textarea" && (
        <Textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={variable.label}
          rows={3}
        />
      )}

      {variable.type === "number" && (
        <Input
          id={id}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={variable.label}
        />
      )}

      {variable.type === "currency" && (
        <CurrencyInput
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {variable.type === "date" && (
        <DateVariableField value={value} onChange={onChange} />
      )}

      {variable.type === "select" && variable.options && (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder={`Select ${variable.label}`} />
          </SelectTrigger>
          <SelectContent>
            {variable.options.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {variable.type === "boolean" && (
        <Switch
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(checked ? "true" : "false")}
        />
      )}

      {variable.type === "boilerplate" && variable.blocks && (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select content..." />
          </SelectTrigger>
          <SelectContent>
            {variable.blocks.map((block) => (
              <SelectItem key={block.value} value={block.value}>
                {block.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date Field
// ---------------------------------------------------------------------------

function DateVariableField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const date = value ? new Date(value) : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground"
          )}
        >
          <CalendarIcon className="mr-2 size-4" />
          {date ? format(date, "PPP") : "Pick a date"}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={(d) => onChange(d ? d.toISOString().split("T")[0] : "")}
        />
      </PopoverContent>
    </Popover>
  );
}

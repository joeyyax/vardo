"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { DocumentBuilder } from "./document-builder";
import { LockBanner } from "./lock-banner";
import { LockRequestListener } from "./lock-request-listener";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type {
  TemplateSection,
  TemplateVariable,
  TemplatePricingConfig,
  DocumentContent,
  RenderedSection,
  RenderContext,
} from "@/lib/template-engine/types";

type SerializedDocument = {
  id: string;
  type: string;
  status: string;
  title: string;
  content: DocumentContent | null;
  templateId?: string | null;
  variableValues?: Record<string, string> | null;
  requiresContract: boolean;
  publicToken: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  acceptedBy: string | null;
  declinedBy: string | null;
  declineReason: string | null;
};

type Template = {
  id: string;
  name: string;
  displayLabel: string | null;
  sections: TemplateSection[];
  variableSchema: TemplateVariable[];
  pricingConfig: TemplatePricingConfig | null;
};

type LockInfo = {
  lockedBy: string;
  userName: string;
  lockedAt: string;
  lastActiveAt: string;
};

type DocumentBuilderWrapperProps = {
  document: SerializedDocument;
  orgId: string;
  projectId: string;
  projectName: string;
  clientName: string;
  clientContactEmail?: string;
  organizationName: string;
  currentUserId: string;
};

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Client-side wrapper that bridges server-fetched document data to the DocumentBuilder.
 * Manages document locking lifecycle: acquire on mount, heartbeat, release on unmount.
 */
export function DocumentBuilderWrapper({
  document,
  orgId,
  projectId,
  projectName,
  clientName,
  clientContactEmail,
  organizationName,
  currentUserId,
}: DocumentBuilderWrapperProps) {
  const router = useRouter();
  const [template, setTemplate] = useState<Template | null>(null);
  const [isLoadingTemplate, setIsLoadingTemplate] = useState(
    !!document.templateId || !!document.content?.templateSections
  );

  // Lock state
  const [lockAcquired, setLockAcquired] = useState(false);
  const [lockInfo, setLockInfo] = useState<LockInfo | null>(null);
  const [lockLoading, setLockLoading] = useState(true);
  const [editRequested, setEditRequested] = useState(false);
  const [lockTransferred, setLockTransferred] = useState(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const context: RenderContext = {
    clientName,
    projectName,
    organizationName,
  };

  const isDraft = document.status === "draft";
  const lockUrl = `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}/lock`;

  // Acquire lock on mount (drafts only)
  useEffect(() => {
    if (!isDraft) {
      setLockLoading(false);
      return;
    }

    let mounted = true;

    async function acquireLock() {
      try {
        const res = await fetch(lockUrl, { method: "POST" });
        const data = await res.json();

        if (!mounted) return;

        if (data.acquired) {
          setLockAcquired(true);
          setLockInfo(null);
        } else {
          setLockAcquired(false);
          setLockInfo({
            lockedBy: data.lockedBy,
            userName: data.userName,
            lockedAt: data.lockedAt,
            lastActiveAt: data.lastActiveAt,
          });
        }
      } catch {
        // On error, allow editing (optimistic)
        if (mounted) setLockAcquired(true);
      } finally {
        if (mounted) setLockLoading(false);
      }
    }

    acquireLock();

    return () => {
      mounted = false;
    };
  }, [isDraft, lockUrl]);

  // Heartbeat while lock is held
  useEffect(() => {
    if (!lockAcquired || !isDraft) return;

    heartbeatRef.current = setInterval(async () => {
      try {
        await fetch(lockUrl, { method: "PATCH" });
      } catch {
        // Heartbeat failure is non-fatal
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [lockAcquired, isDraft, lockUrl]);

  // Release lock on unmount + beforeunload
  useEffect(() => {
    if (!lockAcquired || !isDraft) return;

    function releaseLock() {
      // Use sendBeacon for reliability during page unload
      navigator.sendBeacon?.(lockUrl + "?_method=DELETE");
    }

    window.addEventListener("beforeunload", releaseLock);

    return () => {
      window.removeEventListener("beforeunload", releaseLock);
      // Also release via fetch on component unmount
      fetch(lockUrl, { method: "DELETE" }).catch(() => {});
    };
  }, [lockAcquired, isDraft, lockUrl]);

  // Poll for lock release when we don't hold the lock
  useEffect(() => {
    if (lockAcquired || !lockInfo || !isDraft) return;

    const interval = setInterval(async () => {
      try {
        const res = await fetch(lockUrl, { method: "POST" });
        const data = await res.json();
        if (data.acquired) {
          setLockAcquired(true);
          setLockInfo(null);
          setEditRequested(false);
          setLockTransferred(true);
          toast.success("Lock acquired — you can now edit");
        } else {
          // Update lock info (lastActiveAt may have changed)
          setLockInfo({
            lockedBy: data.lockedBy,
            userName: data.userName,
            lockedAt: data.lockedAt,
            lastActiveAt: data.lastActiveAt,
          });
        }
      } catch {
        // Non-fatal
      }
    }, 10_000); // Poll every 10s

    return () => clearInterval(interval);
  }, [lockAcquired, lockInfo, isDraft, lockUrl]);

  // Fetch template if document has a DB-stored templateId, OR use embedded metadata
  useEffect(() => {
    if (document.templateId) {
      // Fetch from API (custom templates stored in DB)
      async function fetchTemplate() {
        try {
          const response = await fetch(
            `/api/v1/organizations/${orgId}/templates/${document.templateId}`
          );
          if (response.ok) {
            const data = await response.json();
            setTemplate(data);
          }
        } catch (err) {
          console.error("Error fetching template:", err);
        } finally {
          setIsLoadingTemplate(false);
        }
      }
      fetchTemplate();
    } else if (document.content?.templateSections) {
      // Use embedded template metadata (starter templates store this in content)
      setTemplate({
        id: "embedded",
        name: document.content.templateName || "",
        displayLabel: document.content.templateLabel || null,
        sections: document.content.templateSections,
        variableSchema: document.content.variableSchema || [],
        pricingConfig: document.content.pricingConfig || null,
      });
      setIsLoadingTemplate(false);
    } else {
      setIsLoadingTemplate(false);
    }
  }, [orgId, document.templateId, document.content]);

  const handleRequestEdit = useCallback(async () => {
    try {
      const res = await fetch(`${lockUrl}/request`, { method: "POST" });
      const data = await res.json();

      if (data.transferred) {
        setLockAcquired(true);
        setLockInfo(null);
        setLockTransferred(true);
        toast.success("Lock transferred — you can now edit");
      } else if (data.requested) {
        setEditRequested(true);
      }
    } catch {
      toast.error("Failed to request edit access");
    }
  }, [lockUrl]);

  const handleAcceptTransfer = useCallback(async () => {
    try {
      // Release our lock (which auto-saves a revision)
      await fetch(lockUrl, { method: "DELETE" });
      setLockAcquired(false);
      setLockInfo(null);
      toast.success("Lock released — switching to read-only");
      router.refresh();
    } catch {
      toast.error("Failed to release lock");
    }
  }, [lockUrl, router]);

  const handleSave = useCallback(
    async (data: {
      title: string;
      content: DocumentContent;
      variableValues: Record<string, string>;
    }) => {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: data.title,
            content: data.content,
            variableValues: data.variableValues,
          }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        if (response.status === 423) {
          toast.error(`Document is locked by ${error.lockedBy}`);
          return;
        }
        throw new Error(error.error || "Failed to save");
      }

      toast.success("Document saved");
    },
    [orgId, projectId, document.id]
  );

  const handleSend = useCallback(
    async (data: {
      title: string;
      content: DocumentContent;
      variableValues: Record<string, string>;
      recipientEmail?: string;
    }) => {
      // Save first
      const saveResponse = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: data.title,
            content: data.content,
            variableValues: data.variableValues,
          }),
        }
      );

      if (!saveResponse.ok) {
        const error = await saveResponse.json();
        throw new Error(error.error || "Failed to save before sending");
      }

      // Then send
      const sendResponse = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipientEmail: data.recipientEmail,
          }),
        }
      );

      if (!sendResponse.ok) {
        const error = await sendResponse.json();
        throw new Error(error.error || "Failed to send");
      }

      toast.success("Document sent");
      router.refresh();
    },
    [orgId, projectId, document.id, router]
  );

  const handleStatusChange = useCallback(
    async (newStatus: string, reason?: string) => {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${document.id}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: newStatus, reason }),
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update status");
      }

      const statusLabels: Record<string, string> = {
        sent: "Marked as sent",
        accepted: "Marked as accepted",
        declined: "Marked as declined",
        draft: "Reverted to draft",
      };
      toast.success(statusLabels[newStatus] || "Status updated");
      router.refresh();
    },
    [orgId, projectId, document.id, router]
  );

  const handleBack = useCallback(() => {
    router.push(`/projects/${projectId}`);
  }, [router, projectId]);

  if (isLoadingTemplate || lockLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Determine effective read-only state: non-draft OR locked by someone else
  const isLockedByOther = isDraft && !lockAcquired && !!lockInfo;
  const effectiveReadOnly = !isDraft || isLockedByOther;

  const builderProps = {
    readOnly: effectiveReadOnly,
    status: document.status,
    onSave: !effectiveReadOnly ? handleSave : undefined,
    onSend: !effectiveReadOnly ? handleSend : undefined,
    onStatusChange: handleStatusChange,
    onBack: handleBack,
    publicToken: document.publicToken,
    sentAt: document.sentAt,
    viewedAt: document.viewedAt,
    acceptedAt: document.acceptedAt,
    declinedAt: document.declinedAt,
    acceptedBy: document.acceptedBy,
    declinedBy: document.declinedBy,
    declineReason: document.declineReason,
  };

  // If we have a template, use full builder with form fields
  if (template) {
    return (
      <div className="h-[calc(100vh-4rem)] -mx-6 -mb-6 flex flex-col">
        {isLockedByOther && lockInfo && (
          <LockBanner
            userName={lockInfo.userName}
            lastActiveAt={lockInfo.lastActiveAt}
            onRequestEdit={handleRequestEdit}
            requested={editRequested}
            transferred={lockTransferred}
          />
        )}
        {lockAcquired && isDraft && (
          <LockRequestListener
            orgId={orgId}
            projectId={projectId}
            documentId={document.id}
            onAcceptTransfer={handleAcceptTransfer}
          />
        )}
        <div className="flex-1 min-h-0">
          <DocumentBuilder
            title={document.title}
            templateSections={template.sections}
            variableSchema={template.variableSchema}
            pricingConfig={template.pricingConfig}
            templateLabel={template.displayLabel || undefined}
            templateName={template.name}
            context={context}
            initialVariableValues={document.variableValues || {}}
            initialSendEmail={clientContactEmail}
            orgId={orgId}
            projectId={projectId}
            documentId={document.id}
            {...builderProps}
          />
        </div>
      </div>
    );
  }

  // No template — build sections from the document content for read-only/basic editing
  const existingSections: TemplateSection[] = (
    document.content?.sections || []
  ).map((s: RenderedSection) => ({
    key: s.key,
    title: s.title,
    body: s.mode === "editable" ? "" : s.content,
    mode: s.mode || ("editable" as const),
    order: s.order,
  }));

  const existingVarSchema: TemplateVariable[] = existingSections
    .filter((s) => s.mode === "editable")
    .map((s) => ({
      key: `${s.key}_content`,
      label: s.title,
      type: "richtext" as const,
      section: s.key,
    }));

  const existingVarValues: Record<string, string> = {};
  // Pre-rendered HTML for non-editable sections (already processed, skip markdownToHtml)
  const preRenderedHtml: Record<string, string> = {};
  for (const s of document.content?.sections || []) {
    if (s.mode === "editable") {
      existingVarValues[`${s.key}_content`] = s.content;
    } else {
      preRenderedHtml[s.key] = s.content;
    }
  }

  return (
    <div className="h-[calc(100vh-4rem)] -mx-6 -mb-6 flex flex-col">
      {isLockedByOther && lockInfo && (
        <LockBanner
          userName={lockInfo.userName}
          lastActiveAt={lockInfo.lastActiveAt}
          onRequestEdit={handleRequestEdit}
          requested={editRequested}
          transferred={lockTransferred}
        />
      )}
      {lockAcquired && isDraft && (
        <LockRequestListener
          orgId={orgId}
          projectId={projectId}
          documentId={document.id}
          onAcceptTransfer={handleAcceptTransfer}
        />
      )}
      <div className="flex-1 min-h-0">
        <DocumentBuilder
          title={document.title}
          templateSections={existingSections}
          variableSchema={existingVarSchema}
          preRenderedHtml={preRenderedHtml}
          context={context}
          initialVariableValues={{
            ...existingVarValues,
            ...(document.variableValues || {}),
          }}
          initialSendEmail={clientContactEmail}
          orgId={orgId}
          projectId={projectId}
          documentId={document.id}
          {...builderProps}
        />
      </div>
    </div>
  );
}

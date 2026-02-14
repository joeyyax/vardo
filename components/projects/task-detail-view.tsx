"use client";

import { useState, useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import {
  DollarSign,
  Archive,
  Eye,
  EyeOff,
  User,
  Paperclip,
  Bug,
  ExternalLink,
  Monitor,
  ChevronDown,
  ChevronRight,
  FileText,
  Download,
  Globe,
  Wifi,
  AlertTriangle,
  HardDrive,
  Cookie,
  GitBranch,
  CalendarIcon,
} from "lucide-react";
import { format, isPast, isToday } from "date-fns";
import { cn } from "@/lib/utils";
import type { Task, TaskStatus } from "./task-dialog";
import { TASK_STATUS_LABELS, TASK_STATUS_COLORS } from "./task-dialog";

type TaskDetailViewProps = {
  task: Task;
  orgId: string;
  projectId: string;
  onEdit: () => void;
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function CollapsibleSection({
  label,
  icon: Icon,
  children,
  defaultOpen = false,
}: {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-xs"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {Icon && <Icon className="size-3" />}
        {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

function BugReportContext({ metadata }: { metadata: Record<string, unknown> }) {
  const [showUserAgent, setShowUserAgent] = useState(false);

  const pageUrl = metadata.pageUrl as string | undefined;
  const browser = metadata.browser as string | undefined;
  const browserVersion = metadata.browserVersion as string | undefined;
  const os = metadata.os as string | undefined;
  const rawViewport = metadata.viewport;
  const viewport =
    typeof rawViewport === "string"
      ? rawViewport
      : rawViewport && typeof rawViewport === "object" && "width" in rawViewport
        ? `${(rawViewport as { width: number; height: number }).width}x${(rawViewport as { width: number; height: number }).height}`
        : undefined;
  const env = metadata.env as string | undefined;
  const userAgent = metadata.userAgent as string | undefined;
  const ipAddress = metadata.ipAddress as string | undefined;
  const cache = metadata.cache as { transferSize?: number; navigationType?: string; serviceWorkerControlled?: boolean } | undefined;
  const connection = metadata.connection as { type?: string; effectiveType?: string; downlink?: number; rtt?: number } | undefined;
  const cookieNames = metadata.cookieNames as string[] | undefined;
  const recentErrors = metadata.recentErrors as Array<{ message: string; timestamp: number }> | undefined;
  const memory = metadata.memory as { usedJSHeapSize?: number; totalJSHeapSize?: number; jsHeapSizeLimit?: number } | undefined;
  const documentReadyState = metadata.documentReadyState as string | undefined;
  const splitIntoTaskIds = metadata.splitIntoTaskIds as string[] | undefined;
  const splitFromTaskId = metadata.splitFromTaskId as string | undefined;
  const isSplit = metadata.split as boolean | undefined;

  // Use browserVersion (full) if available, else fall back to browser + os
  const systemDisplay = browserVersion
    ? `${browserVersion}${os ? ` on ${os}` : ""}`
    : [browser, os].filter(Boolean).join(" on ") || undefined;

  const hasContext = pageUrl || systemDisplay || viewport || env || userAgent || ipAddress || cache || connection || cookieNames || recentErrors || memory;
  if (!hasContext) return null;

  const envColors: Record<string, string> = {
    production: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
    staging: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
    dev: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
    development: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Bug className="size-4" />
        Bug report context
      </div>

      {/* Split references */}
      {isSplit && splitIntoTaskIds && splitIntoTaskIds.length > 0 && (
        <div className="flex items-start gap-2 text-sm">
          <span className="text-muted-foreground shrink-0 w-20">Split into</span>
          <div className="flex items-center gap-1 flex-wrap">
            <GitBranch className="size-3 text-muted-foreground" />
            <span>{splitIntoTaskIds.length} tasks</span>
          </div>
        </div>
      )}

      {splitFromTaskId && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground shrink-0 w-20">Split from</span>
          <div className="flex items-center gap-1">
            <GitBranch className="size-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Parent task</span>
          </div>
        </div>
      )}

      <div className="space-y-2 text-sm">
        {pageUrl && (
          <div className="flex items-start gap-2">
            <span className="text-muted-foreground shrink-0 w-20">Page</span>
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:underline dark:text-blue-400 truncate"
            >
              {pageUrl}
              <ExternalLink className="inline size-3 ml-1" />
            </a>
          </div>
        )}

        {systemDisplay && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">System</span>
            <div className="flex items-center gap-1">
              <Monitor className="size-3 text-muted-foreground" />
              <span>{systemDisplay}</span>
            </div>
          </div>
        )}

        {viewport && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">Viewport</span>
            <span>{viewport.replace("x", " \u00d7 ")}</span>
          </div>
        )}

        {env && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">Env</span>
            <Badge className={cn("text-xs", envColors[env.toLowerCase()] || "")}>
              {env}
            </Badge>
          </div>
        )}

        {ipAddress && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">IP</span>
            <div className="flex items-center gap-1">
              <Globe className="size-3 text-muted-foreground" />
              <span>{ipAddress}</span>
            </div>
          </div>
        )}

        {documentReadyState && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">Ready state</span>
            <Badge variant="outline" className="text-xs">{documentReadyState}</Badge>
          </div>
        )}

        {connection && (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground shrink-0 w-20">Connection</span>
            <div className="flex items-center gap-1">
              <Wifi className="size-3 text-muted-foreground" />
              <span>
                {[
                  connection.effectiveType,
                  connection.rtt != null ? `${connection.rtt}ms RTT` : null,
                  connection.downlink != null ? `${connection.downlink} Mbps` : null,
                ].filter(Boolean).join(", ")}
              </span>
            </div>
          </div>
        )}

        {cache && (
          <CollapsibleSection label="Cache info" icon={HardDrive}>
            <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 space-y-1">
              <div>{cache.transferSize === 0 ? "Page was cached" : "Page was loaded fresh"}</div>
              {cache.navigationType && <div>Navigation: {cache.navigationType}</div>}
              {cache.serviceWorkerControlled && <div>Service worker controlled</div>}
            </div>
          </CollapsibleSection>
        )}

        {memory && (
          <CollapsibleSection label="Memory" icon={HardDrive}>
            <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 space-y-1">
              <div>Used: {formatFileSize(memory.usedJSHeapSize ?? 0)}</div>
              <div>Total: {formatFileSize(memory.totalJSHeapSize ?? 0)}</div>
              <div>Limit: {formatFileSize(memory.jsHeapSizeLimit ?? 0)}</div>
            </div>
          </CollapsibleSection>
        )}

        {cookieNames && cookieNames.length > 0 && (
          <CollapsibleSection label={`Cookies (${cookieNames.length})`} icon={Cookie}>
            <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 break-all">
              {cookieNames.join(", ")}
            </div>
          </CollapsibleSection>
        )}

        {recentErrors && recentErrors.length > 0 && (
          <CollapsibleSection label={`Recent errors (${recentErrors.length})`} icon={AlertTriangle} defaultOpen>
            <div className="text-xs bg-muted/50 rounded p-2 space-y-2">
              {recentErrors.map((err, i) => (
                <div key={i} className="space-y-0.5">
                  <div className="text-red-600 dark:text-red-400 break-all">{err.message}</div>
                  <div className="text-muted-foreground">
                    {new Date(err.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}

        {userAgent && (
          <div>
            <button
              type="button"
              onClick={() => setShowUserAgent(!showUserAgent)}
              className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors text-xs"
            >
              {showUserAgent ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              User agent
            </button>
            {showUserAgent && (
              <p className="text-xs text-muted-foreground mt-1 break-all bg-muted/50 rounded p-2">
                {userAgent}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function FileAttachment({
  file,
  orgId,
  projectId,
}: {
  file: { id: string; name: string; mimeType: string; sizeBytes: number };
  orgId: string;
  projectId: string;
}) {
  const [viewUrl, setViewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [imgError, setImgError] = useState(false);

  const fetchViewUrl = async () => {
    if (viewUrl || loading) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/projects/${projectId}/files/${file.id}?action=view`
      );
      if (res.ok) {
        const data = await res.json();
        setViewUrl(data.viewUrl);
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  const isImage = isImageMimeType(file.mimeType);

  // Auto-fetch URL for images on mount
  useEffect(() => {
    if (isImage) {
      fetchViewUrl();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isImage]);

  if (isImage) {
    return (
      <div className="space-y-1">
        {viewUrl && !imgError ? (
          <a href={viewUrl} target="_blank" rel="noopener noreferrer" className="block">
            <img
              src={viewUrl}
              alt={file.name}
              className="rounded border max-h-48 object-contain bg-muted/30"
              onError={() => setImgError(true)}
            />
          </a>
        ) : (
          <div className="rounded border bg-muted/30 h-24 flex items-center justify-center text-xs text-muted-foreground">
            {loading ? "Loading..." : imgError ? "Image not available — file may still be uploading" : "Image unavailable"}
          </div>
        )}
        <p className="text-xs text-muted-foreground">{file.name} ({formatFileSize(file.sizeBytes)})</p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm p-2 rounded border bg-muted/20">
      <FileText className="size-4 text-muted-foreground shrink-0" />
      <span className="truncate flex-1">{file.name}</span>
      <span className="text-xs text-muted-foreground shrink-0">
        {formatFileSize(file.sizeBytes)}
      </span>
      <button
        type="button"
        onClick={fetchViewUrl}
        className="text-muted-foreground hover:text-foreground transition-colors"
      >
        {viewUrl ? (
          <a href={viewUrl} target="_blank" rel="noopener noreferrer">
            <Download className="size-4" />
          </a>
        ) : (
          <Download className="size-4" />
        )}
      </button>
    </div>
  );
}

export function TaskDetailView({ task, orgId, projectId, onEdit }: TaskDetailViewProps) {
  const isBugReport = task.metadata?.source === "widget" || !!task.metadata?.bugReportId;
  const creatorLabel = isBugReport ? "Reported by" : "Created by";
  const creatorName =
    task.createdByUser?.name || task.createdByUser?.email || null;
  const assigneeName =
    task.assignedToUser?.name || task.assignedToUser?.email || "Unassigned";

  return (
    <div className="space-y-6">
      {/* Main headline: Name */}
      <div>
        <h2 className="text-2xl font-semibold">{task.name}</h2>
      </div>

      {/* Description */}
      {task.description && (
        <div>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">
            {task.description}
          </p>
        </div>
      )}

      {/* Status, Type, and Badges */}
      <div className="flex flex-wrap items-center gap-2">
        {task.status && (
          <Badge
            className={cn(
              "text-xs",
              TASK_STATUS_COLORS[task.status as TaskStatus]
            )}
          >
            {TASK_STATUS_LABELS[task.status as TaskStatus]}
          </Badge>
        )}

        {task.type && (
          <Badge variant="outline" className="text-xs">
            {task.type.name}
          </Badge>
        )}

        {task.isBillable !== null && (
          <Badge
            variant={task.isBillable ? "default" : "secondary"}
            className={cn(
              "text-xs",
              task.isBillable && "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
            )}
          >
            <DollarSign className="size-3 mr-1" />
            {task.isBillable ? "Billable" : "Non-billable"}
          </Badge>
        )}

        {task.isArchived && (
          <Badge variant="secondary" className="text-xs">
            <Archive className="size-3 mr-1" />
            Archived
          </Badge>
        )}

        {!!task.metadata?.split && (
          <Badge variant="secondary" className="text-xs">
            <GitBranch className="size-3 mr-1" />
            Split
          </Badge>
        )}

        {task.isClientVisible !== undefined && (
          <Badge variant="outline" className="text-xs">
            {task.isClientVisible ? (
              <>
                <Eye className="size-3 mr-1" />
                Visible to client
              </>
            ) : (
              <>
                <EyeOff className="size-3 mr-1" />
                Internal only
              </>
            )}
          </Badge>
        )}
      </div>

      {/* People */}
      {(creatorName || task.assignedTo !== undefined) && (
        <div className="grid grid-cols-2 gap-4 text-sm">
          {creatorName && (
            <div>
              <div className="text-muted-foreground">{creatorLabel}</div>
              <div className="font-medium flex items-center gap-1.5">
                <User className="size-3.5 text-muted-foreground" />
                {creatorName}
              </div>
            </div>
          )}
          <div>
            <div className="text-muted-foreground">Assigned to</div>
            <div className={cn("font-medium flex items-center gap-1.5", !task.assignedTo && "text-muted-foreground")}>
              <User className="size-3.5 text-muted-foreground" />
              {assigneeName}
            </div>
          </div>
        </div>
      )}

      {/* Details grid */}
      <div className="grid grid-cols-2 gap-4 text-sm">
        {task.estimateMinutes && (
          <div>
            <div className="text-muted-foreground">Time estimate</div>
            <div className="font-medium">
              {(task.estimateMinutes / 60).toFixed(1)} hours
            </div>
          </div>
        )}

        {task.rateOverride !== null && (
          <div>
            <div className="text-muted-foreground">Hourly rate</div>
            <div className="font-medium">
              ${(task.rateOverride / 100).toFixed(2)}
            </div>
          </div>
        )}

        {task.dueDate && (
          <div>
            <div className="text-muted-foreground">Due date</div>
            <div className={cn(
              "font-medium flex items-center gap-1.5",
              task.status !== "done" && isPast(new Date(task.dueDate + "T00:00:00")) && !isToday(new Date(task.dueDate + "T00:00:00"))
                ? "text-red-600 dark:text-red-400"
                : ""
            )}>
              <CalendarIcon className="size-3.5 text-muted-foreground" />
              {format(new Date(task.dueDate + "T00:00:00"), "PPP")}
              {task.status !== "done" && isPast(new Date(task.dueDate + "T00:00:00")) && !isToday(new Date(task.dueDate + "T00:00:00")) && (
                <span className="text-xs">(overdue)</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* PR Link */}
      {task.prLink && (
        <div>
          <div className="text-sm text-muted-foreground mb-1">PR / Code link</div>
          <a
            href={task.prLink}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-600 hover:underline dark:text-blue-400"
          >
            {task.prLink}
          </a>
        </div>
      )}

      {/* Attachments */}
      {task.files && task.files.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Paperclip className="size-4" />
            Attachments ({task.files.length})
          </div>
          <div className="space-y-2">
            {task.files.filter((tf) => tf.file).map((tf) => (
              <FileAttachment
                key={tf.file.id}
                file={tf.file}
                orgId={orgId}
                projectId={projectId}
              />
            ))}
          </div>
        </div>
      )}

      {/* Bug report context */}
      {isBugReport && task.metadata && (
        <div className="border-t pt-6">
          <BugReportContext metadata={task.metadata} />
        </div>
      )}
    </div>
  );
}

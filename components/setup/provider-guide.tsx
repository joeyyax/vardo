"use client";

import { useState } from "react";
import { ChevronDown, ExternalLink, Copy, Check } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

/**
 * Collapsible guidance panel for setup steps and admin settings.
 * Shows a title, optional description, and expandable detailed content.
 */
export function ProviderGuide({
  title,
  description,
  defaultOpen = false,
  children,
}: {
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border bg-muted/30 px-3 py-2.5 text-left hover:bg-muted/50 transition-colors">
        <div className="space-y-0.5">
          <div className="text-sm font-medium">{title}</div>
          {description && (
            <div className="text-xs text-muted-foreground">{description}</div>
          )}
        </div>
        <ChevronDown
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-b-lg border border-t-0 px-3 py-3 space-y-3 text-sm">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A numbered step list for instructions.
 */
export function StepList({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/**
 * External link styled consistently for provider guides.
 */
export function GuideLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {children}
      <ExternalLink className="size-3" />
    </a>
  );
}

/**
 * Copyable read-only value field (e.g., webhook URL, IAM policy).
 */
export function CopyableField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  }

  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border bg-muted/50 px-2 py-1.5 text-xs font-mono break-all">
          {value}
        </code>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 rounded p-1.5 hover:bg-muted transition-colors"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <Check className="size-3.5 text-status-success" />
          ) : (
            <Copy className="size-3.5 text-muted-foreground" />
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Small helper text below a form field.
 */
export function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground">{children}</p>
  );
}

/**
 * Permission badge list.
 */
export function PermissionList({
  permissions,
}: {
  permissions: readonly { scope: string; access: string }[];
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">Required permissions</div>
      <div className="flex flex-wrap gap-1.5">
        {permissions.map((p) => (
          <span
            key={p.scope}
            className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs text-muted-foreground"
          >
            {p.scope}: {p.access}
          </span>
        ))}
      </div>
    </div>
  );
}

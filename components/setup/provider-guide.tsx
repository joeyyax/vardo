"use client";

import { copyToClipboard } from "@/lib/clipboard";
import { useState } from "react";
import { ChevronDown, ExternalLink, Copy, Check } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

/** Collapsible guidance panel for setup steps and admin settings. */
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
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg bg-background-deep px-3 py-2.5 text-left hover:bg-accent/50 transition-colors data-[state=open]:rounded-b-none">
        <div className="space-y-0.5">
          <div className="type-h4">{title}</div>
          {description && (
            <div className="text-xs text-muted-foreground">{description}</div>
          )}
        </div>
        <ChevronDown
          aria-hidden="true"
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="rounded-b-lg bg-background-deep px-3 pt-1 pb-3 space-y-3 text-sm">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Numbered step list. */
export function StepList({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
      {steps.map((step, i) => (
        <li key={i}>{step}</li>
      ))}
    </ol>
  );
}

/** External link for provider guides. */
export function GuideLink({
  href,
  children,
}: {
  href: string | null;
  children: React.ReactNode;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {children}
      <ExternalLink aria-hidden="true" className="size-3" />
      <span className="sr-only">(opens in new tab)</span>
    </a>
  );
}

/** Copyable read-only value, e.g. a webhook URL or IAM policy. */
export function CopyableField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!(await copyToClipboard(value))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-1">
      <div className="type-label text-muted-foreground">{label}</div>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border bg-muted/50 px-2 py-1.5 text-xs font-mono break-all">
          {value}
        </code>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          onClick={handleCopy}
          className="shrink-0"
          aria-label={`Copy ${label}`}
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-status-success" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5 text-muted-foreground" />
          )}
        </Button>
      </div>
    </div>
  );
}

/** Helper text below a form field. */
export function FieldHint({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs text-muted-foreground">{children}</p>
  );
}

/** Permission badge list. */
export function PermissionList({
  permissions,
}: {
  permissions: readonly { scope: string; access: string }[];
}) {
  return (
    <div className="space-y-1">
      <div className="type-label text-muted-foreground">Required permissions</div>
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

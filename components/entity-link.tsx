"use client";

import type { ComponentProps, MouseEvent, ReactNode } from "react";
import Link from "next/link";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { copyToClipboard } from "@/lib/clipboard";
import { siteUrl } from "@/lib/ui/hrefs";
import { cn } from "@/lib/utils";

/** Calm link styling: inherits color, underlines on hover, keeps a visible focus ring. */
export const entityLinkClass =
  "cursor-pointer rounded-[3px] decoration-current/40 underline-offset-[3px] hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass";

/** Secondary text that brightens on hover. */
export const quietLinkClass = cn(entityLinkClass, "text-muted-foreground hover:text-foreground");

/** Clicks stay on the link, so a row around it doesn't also act. */
function stop(e: MouseEvent<HTMLAnchorElement>) {
  e.stopPropagation();
}

/** A name or reference that is a real link: middle- and Cmd/Ctrl-click open a new tab. */
export function EntityLink({
  href,
  className,
  onClick,
  ...props
}: ComponentProps<typeof Link> & { href: string }) {
  return (
    <Link
      href={href}
      data-entity-link
      className={cn(entityLinkClass, className)}
      onClick={(e) => {
        stop(e);
        onClick?.(e);
      }}
      {...props}
    />
  );
}

/** A domain that opens the site in a new tab, with an external-link mark on hover. */
export function DomainLink({
  domain,
  className,
  children,
  tabIndex,
}: {
  domain: string;
  className?: string;
  children?: ReactNode;
  tabIndex?: number;
}) {
  return (
    <a
      href={siteUrl(domain)}
      target="_blank"
      rel="noreferrer"
      data-entity-link
      tabIndex={tabIndex}
      onClick={stop}
      title={`Open ${domain} in a new tab`}
      className={cn("group/domain inline-flex min-w-0 items-center gap-1", entityLinkClass, className)}
    >
      <span className="truncate">{children ?? domain}</span>
      <ExternalLink
        aria-hidden="true"
        className="size-3 shrink-0 opacity-0 transition-opacity group-hover/domain:opacity-60 group-focus-visible/domain:opacity-60"
      />
    </a>
  );
}

/** Copies a value; says so when it lands. */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async (e) => {
        e.stopPropagation();
        if (!(await copyToClipboard(value))) return;
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-brass",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
    </button>
  );
}

"use client";

import { useState, useCallback } from "react";

interface TerminalBlockProps {
  command: string;
  className?: string;
}

export function TerminalBlock({ command, className }: TerminalBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement("textarea");
      textarea.value = command;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [command]);

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border border-border bg-neutral-950 ${className ?? ""}`}
    >
      {/* macOS window chrome */}
      <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
      </div>

      {/* Terminal content */}
      <div className="relative px-5 py-4">
        <pre className="overflow-x-auto font-mono text-sm leading-relaxed text-neutral-200">
          <span className="select-none text-emerald-400">$ </span>
          {command}
        </pre>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-white/5 p-2 text-neutral-400 opacity-0 backdrop-blur-sm transition-all duration-200 hover:bg-white/10 hover:text-neutral-200 group-hover:opacity-100"
          aria-label={copied ? "Copied" : "Copy command"}
          type="button"
        >
          {copied ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

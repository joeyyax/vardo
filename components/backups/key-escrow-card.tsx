"use client";

import { useEffect, useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";
import { Term } from "@/components/term";
import { copyToClipboard } from "@/lib/clipboard";

type KeyEscrowState = {
  severity: "ok" | "warning" | "critical";
  headline: string;
  detail: string;
  technical: string | null;
  status: string;
  fingerprint: string | null;
  recorded: string | null;
  encrypted: number;
  undecryptable: number;
  samples: string[];
};

const VARIANT = {
  ok: "success",
  warning: "warning",
  critical: "error",
} as const;

const KEY_COMMAND = "vardo key";

function CopyCommand() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!(await copyToClipboard(KEY_COMMAND))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground">{KEY_COMMAND}</code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy ${KEY_COMMAND}`}
        title="Copy"
        className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass"
      >
        {copied ? <Check className="size-3.5 text-status-success" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
    </span>
  );
}

/** The server's recovery key: whether it opens this server's encrypted data, and how to keep a copy. */
export function KeyEscrowCard({ heading = "h3" }: { heading?: "h2" | "h3" }) {
  const [state, setState] = useState<KeyEscrowState | null>(null);

  useEffect(() => {
    fetch("/api/v1/system/encryption-key")
      .then((res) => (res.ok ? res.json() : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;

  return (
    <Card id="recovery-key" className="scroll-mt-24">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-4">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        <CardTitle as={heading}>Recovery key</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.severity === "ok" ? (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-medium">
              <Check className="size-4 text-status-success" aria-hidden="true" />
              {state.headline}
            </p>
            <p className="text-sm text-muted-foreground">{state.detail}</p>
          </div>
        ) : (
          <Callout variant={VARIANT[state.severity]} label={state.headline}>
            {state.detail}
          </Callout>
        )}

        {state.samples.length > 0 ? (
          <p className="text-sm text-muted-foreground">Affected: {state.samples.join(", ")}</p>
        ) : null}

        <p className="text-sm text-muted-foreground">
          To restore on a new server you&apos;ll need this key and the sign-in secret. Neither is stored in a backup.
          Run <CopyCommand /> on this server to show both, and save them in your password manager.
        </p>

        {state.fingerprint ? (
          <p className="text-xs text-muted-foreground">
            <Term id="key-fingerprint">Fingerprint</Term>{" "}
            <code className="font-mono">{state.fingerprint}</code> — matches the one saved with your key if
            it&apos;s the same key.
          </p>
        ) : null}

        <p className="text-xs text-muted-foreground/70">
          Technical details: the key is ENCRYPTION_MASTER_KEY and the sign-in secret is BETTER_AUTH_SECRET.
          {state.technical ? ` ${state.technical}` : null}
        </p>
      </CardContent>
    </Card>
  );
}

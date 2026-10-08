"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Callout } from "@/components/ui/callout";

type KeyEscrowState = {
  severity: "ok" | "warning" | "critical";
  headline: string;
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

/** The master key's identity, and whether it matches this database. */
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
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-4">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        <CardTitle as={heading}>Encryption key</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Callout variant={VARIANT[state.severity]}>{state.headline}</Callout>

        {state.fingerprint ? (
          <p className="text-sm text-muted-foreground">
            Key ID <code className="font-mono text-foreground">{state.fingerprint}</code>
            {state.encrypted > 0 ? ` — opens ${state.encrypted - state.undecryptable} of ${state.encrypted} encrypted values` : null}
          </p>
        ) : null}

        {state.samples.length > 0 ? (
          <p className="text-sm text-muted-foreground">Affected: {state.samples.join(", ")}</p>
        ) : null}

        <p className="text-sm text-muted-foreground">
          ENCRYPTION_MASTER_KEY and BETTER_AUTH_SECRET are never in a backup. Without them, a restore onto a new
          host can't read env vars or archives, and two-factor sign-in stops working.
        </p>

        <p className="text-sm text-muted-foreground">
          Read both on the host with <code className="font-mono text-foreground">vardo key</code>, then keep them in a
          password manager. The Key ID above confirms an escrowed master key is the right one.
        </p>
      </CardContent>
    </Card>
  );
}

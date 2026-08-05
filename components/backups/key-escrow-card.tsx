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
export function KeyEscrowCard() {
  const [state, setState] = useState<KeyEscrowState | null>(null);

  useEffect(() => {
    fetch("/api/v1/system/encryption-key")
      .then((res) => (res.ok ? res.json() : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0 pb-4">
        <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
        <CardTitle className="text-sm font-medium">Encryption key</CardTitle>
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
          ENCRYPTION_MASTER_KEY is deliberately not in any backup — an archive that held it would hand every secret
          to whoever holds the archive. Store it somewhere else, or a restore onto a new host leaves every env var
          unreadable.
        </p>

        <p className="text-sm text-muted-foreground">
          Read it on the host with <code className="font-mono text-foreground">vardo key</code>, then keep it in a
          password manager. The Key ID above confirms an escrowed copy is the right one.
        </p>
      </CardContent>
    </Card>
  );
}

"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/lib/messenger";
import type { ResolvedCommitment } from "@/lib/trust/commitments";
import type { TrustView } from "@/lib/trust/view";

type Props = {
  commitments: ResolvedCommitment[];
  busy: boolean;
  call: (method: "PATCH" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => Promise<TrustView | null>;
};

const ENDPOINT = "/api/v1/admin/trust/commitments";
const UNIT: Record<ResolvedCommitment["unit"], string> = { hours: "hours", days: "days", percent: "%" };

function Row({ c, busy, call }: { c: ResolvedCommitment; busy: boolean; call: Props["call"] }) {
  const [draft, setDraft] = useState(c.amount === null ? "" : String(c.amount));

  async function toggle(enabled: boolean) {
    const saved = await call("PATCH", ENDPOINT, { id: c.id, enabled });
    if (saved) toast.success(enabled ? `${c.label} on` : `${c.label} off`, { action: { label: "Undo", onClick: () => void call("PATCH", ENDPOINT, { id: c.id, enabled: !enabled }) } });
  }

  async function commit() {
    const text = draft.trim();
    const amount = text === "" ? null : Number(text);
    if (amount === c.amount) return;
    if (amount !== null && !Number.isFinite(amount)) {
      toast.error(`${c.label} must be a number`);
      setDraft(c.amount === null ? "" : String(c.amount));
      return;
    }
    const saved = await call("PATCH", ENDPOINT, { id: c.id, amount });
    if (saved) toast.success("Saved");
    else setDraft(c.amount === null ? "" : String(c.amount));
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <Switch checked={c.enabled} disabled={busy || c.locked} onCheckedChange={(next) => void toggle(next)} aria-label={`${c.label} on the public page`} />
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium">{c.label}</div>
        <div className="text-xs text-muted-foreground">
          {c.measured ? "Your commitment. Vardo measures it." : "Your commitment."} {c.help}
        </div>
        {c.enabled && c.blocker && <div className="text-xs text-status-warning">{c.blocker}</div>}
        {!c.enabled && c.locked && c.blocker && <div className="text-xs text-muted-foreground">{c.blocker}</div>}
      </div>
      <div className="flex w-44 items-center justify-end gap-2 text-sm">
        {c.derived ? (
          <span className="text-muted-foreground">{c.value ?? (c.amount === null ? "No value" : "Off")}</span>
        ) : (
          <>
            <Input
              type="number"
              inputMode="decimal"
              aria-label={`${c.label} value`}
              className="h-8 w-24 text-right tabular-nums"
              value={draft}
              min={c.min}
              max={c.max}
              step={c.unit === "percent" ? 0.01 : 1}
              placeholder={c.hint}
              disabled={busy}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void commit()}
            />
            <span className="w-10 text-muted-foreground">{UNIT[c.unit]}</span>
          </>
        )}
      </div>
    </li>
  );
}

export function CommitmentsCard({ commitments, busy, call }: Props) {
  return (
    <Card id="commitments" variant="surface" className="space-y-2 py-5">
      <CardHeader>
        <CardTitle>Commitments</CardTitle>
        <p className="text-sm text-muted-foreground">Published when on. Vardo reads three from your settings; you set the rest.</p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {commitments.map((c) => <Row key={`${c.id}:${c.amount}`} c={c} busy={busy} call={call} />)}
        </ul>
      </CardContent>
    </Card>
  );
}

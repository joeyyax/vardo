"use client";

import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/messenger";

export type CheckResponse = {
  verified: boolean;
  lookupFailed: boolean;
  recordName: string;
  recordValue: string;
  found: string[];
};

/** Runs a Check request and reports the outcome as a toast. Returns the response, or null if the request failed. */
export async function runOwnershipCheck(url: string, body: object): Promise<CheckResponse | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast.error(data.error || "Couldn't check the domain");
      return null;
    }
    const data: CheckResponse = await res.json();
    if (data.verified) toast.success("Domain verified");
    else if (data.lookupFailed) toast.error("Couldn't look up the TXT record. Try again in a moment.");
    else toast.error("TXT record not found yet. DNS changes can take a few minutes.");
    return data;
  } catch {
    toast.error("Couldn't check the domain");
    return null;
  }
}

function Copyable({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="type-label text-muted-foreground mt-1 w-12 shrink-0">{label}</span>
      <button
        type="button"
        title="Copy"
        onClick={() => copyToClipboard(value).then((ok) => ok && toast.success("Copied"))}
        className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground text-left break-all hover:opacity-70"
      >
        {value}
      </button>
    </div>
  );
}

/** The TXT record to add and the Check button. */
export function OwnershipChallenge({
  recordName,
  recordValue,
  checking,
  onCheck,
}: {
  recordName: string;
  recordValue: string | null;
  checking: boolean;
  onCheck: () => void;
}) {
  return (
    <div className="space-y-2 border-t border-border/50 px-4 py-3" data-testid="ownership-challenge">
      <p className="text-xs text-muted-foreground">
        Add this TXT record at your DNS provider to prove you own the domain.
      </p>
      <Copyable label="Name" value={recordName} />
      {recordValue && <Copyable label="Value" value={recordValue} />}
      <Button size="xs" variant="outline" onClick={onCheck} disabled={checking}>
        {checking ? <><Loader2 className="mr-1 size-3 animate-spin" />Checking</> : "Check"}
      </Button>
    </div>
  );
}

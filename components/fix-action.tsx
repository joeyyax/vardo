"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/messenger";
import type { FixAction, Problem } from "@/lib/ui/conditions";
import { runDeploy } from "@/lib/ui/run-deploy";

export type RunAction = "deploy" | "restart" | "backup";

const BUSY: Record<RunAction, string> = {
  deploy: "Deploying…",
  restart: "Restarting…",
  backup: "Starting backup…",
};

const DONE: Record<RunAction, string> = {
  deploy: "deployed",
  restart: "restarted",
  backup: "backup started",
};

export type FixTarget = { id: string; name: string; displayName: string };
export type Handled = { name: string; displayName: string; title: string; outcome: string };

async function post(url: string): Promise<void> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Failed (${res.status})`);
  }
}

/** Runs one-click fixes, tracks which are in flight and remembers what was handled this visit. */
export function useFixRunner(orgId: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [handled, setHandled] = useState<Handled[]>([]);

  /** Runs an action. With a problem, a success counts as handled. */
  const run = useCallback(
    async (target: FixTarget, action: RunAction, fixing?: Problem) => {
      setBusy((s) => new Set(s).add(target.name));
      try {
        const base = `/api/v1/organizations/${orgId}/apps/${target.id}`;
        if (action === "deploy") await runDeploy(orgId, target.id);
        else if (action === "restart") await post(`${base}/restart`);
        else await post(`${base}/backup-now`);
        if (fixing) {
          setHandled((h) => [...h, { name: target.name, displayName: target.displayName, title: fixing.title, outcome: DONE[action] }]);
        }
        toast.success(`${target.displayName} ${DONE[action]}`);
        router.refresh();
      } catch (err) {
        toast.error(`${target.displayName}: ${err instanceof Error ? err.message : "that didn't run"}`);
      } finally {
        setBusy((s) => {
          const next = new Set(s);
          next.delete(target.name);
          return next;
        });
      }
    },
    [orgId, router],
  );

  return { busy, handled, run };
}

/** A problem's one-click fix, or a link when the fix is a page. */
export function FixButton({
  fix,
  busy,
  onRun,
  size = "xs",
  variant = "outline",
  tabIndex,
}: {
  fix: FixAction;
  busy: boolean;
  onRun: () => void;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "default" | "ghost";
  tabIndex?: number;
}) {
  if ("href" in fix) {
    return (
      <Button asChild size={size} variant={variant} tabIndex={tabIndex}>
        <Link href={fix.href}>{fix.label}</Link>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      disabled={busy}
      aria-busy={busy}
      tabIndex={tabIndex}
      onClick={(e) => {
        e.stopPropagation();
        onRun();
      }}
    >
      {busy && <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {busy ? BUSY[fix.run] : fix.label}
    </Button>
  );
}

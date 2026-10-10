"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "@/lib/messenger";
import type { AttentionAction } from "@/lib/ui/attention";

const LINK = "ml-1 text-foreground underline underline-offset-2";

/** A row's action: a link, or a POST, behind a confirm when it has one. */
export function AttentionActionLink({ action }: { action: AttentionAction }) {
  const [busy, setBusy] = useState(false);

  if ("href" in action) {
    return (
      <Link href={action.href} className={LINK}>
        {action.label}
      </Link>
    );
  }

  async function run() {
    if (!("post" in action)) return;
    setBusy(true);
    try {
      const res = await fetch(action.post, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        toast.error(data.error ?? "Couldn't start it");
        return;
      }
      toast.success(data.message ?? "Started");
    } catch {
      toast.error("Couldn't start it");
    } finally {
      setBusy(false);
    }
  }

  const label = (
    <>
      {busy && <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
      {action.label}
    </>
  );

  if (!action.confirm) {
    return (
      <button type="button" className={`${LINK} inline-flex items-center gap-1`} disabled={busy} onClick={() => void run()}>
        {label}
      </button>
    );
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button type="button" className={`${LINK} inline-flex items-center gap-1`} disabled={busy}>
          {label}
        </button>
      </AlertDialogTrigger>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{action.confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{action.confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void run()}>{action.confirm.label}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

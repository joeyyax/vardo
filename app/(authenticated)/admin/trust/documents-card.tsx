"use client";

import { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { StatusMark, type StatusDotTone } from "@/components/ui/status-dot";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/messenger";
import type { PolicyView } from "@/lib/trust/documents";
import type { TrustView } from "@/lib/trust/view";

type Call = (method: "PATCH" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => Promise<TrustView | null>;

const ENDPOINT = "/api/v1/admin/trust/documents";

const STATE: Record<PolicyView["state"], { tone: StatusDotTone; pending?: boolean; label: string }> = {
  reviewed: { tone: "good", label: "Public" },
  review: { tone: "warn", label: "Needs review" },
  draft: { tone: "neutral", pending: true, label: "Draft" },
};

function date(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function Row({ icon = <FileText className="size-4" />, title, description, status, actions }: { icon?: React.ReactNode; title: string; description: string; status: React.ReactNode; actions: React.ReactNode }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">{status}{actions}</div>
    </li>
  );
}

function PolicyRow({ policy, busy, call }: { policy: PolicyView; busy: boolean; call: Call }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(policy.draft);
  const mark = STATE[policy.state];

  async function publish() {
    const saved = await call("POST", `${ENDPOINT}/${policy.id}`, { action: "publish", body: text });
    if (saved) {
      setOpen(false);
      toast.success(`${policy.title} published`);
    }
  }

  async function unpublish() {
    const saved = await call("POST", `${ENDPOINT}/${policy.id}`, { action: "unpublish" });
    if (saved) {
      setOpen(false);
      toast.success(`${policy.title} unpublished`);
    }
  }

  return (
    <>
      <Row
        title={policy.title}
        description={policy.description}
        status={
          <span className="flex items-center gap-1.5">
            <StatusMark tone={mark.tone} pending={mark.pending} />
            {mark.label}{policy.reviewedAt && policy.state !== "draft" ? ` · reviewed ${date(policy.reviewedAt)}` : ""}
          </span>
        }
        actions={
          <Button size="xs" variant="outline" onClick={() => { setText(policy.draft); setOpen(true); }}>
            {policy.state === "reviewed" ? "View" : "Review"}
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{policy.title}</DialogTitle>
            <DialogDescription>
              Written from your current settings. Edit it, then publish. The public page shows the version you publish
              {policy.published && policy.state === "review" ? `, and keeps the version reviewed ${date(policy.reviewedAt!)} until you do` : ""}.
            </DialogDescription>
          </DialogHeader>
          <Textarea aria-label={`${policy.title} text`} value={text} onChange={(e) => setText(e.target.value)} className="max-h-[50vh] min-h-72 font-mono text-xs" />
          <DialogFooter>
            {policy.published && <Button variant="outline" disabled={busy} onClick={() => void unpublish()}>Unpublish</Button>}
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button disabled={busy || !text.trim()} onClick={() => void publish()}>Publish this version</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function DpaRow({ dpa, busy, call }: { dpa: TrustView["documents"]["dpa"]; busy: boolean; call: Call }) {
  const input = useRef<HTMLInputElement>(null);

  async function upload(file: File | undefined) {
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    if (await call("PUT", `${ENDPOINT}/dpa`, form)) toast.success("Uploaded. It stays private until you publish it.");
    if (input.current) input.current.value = "";
  }

  async function act(action: "publish" | "unpublish") {
    const saved = await call("POST", `${ENDPOINT}/dpa`, { action });
    if (saved) toast.success(action === "publish" ? "Agreement published" : "Agreement unpublished", { action: { label: "Undo", onClick: () => void call("POST", `${ENDPOINT}/dpa`, { action: action === "publish" ? "unpublish" : "publish" }) } });
  }

  async function remove() {
    if (await call("DELETE", `${ENDPOINT}/dpa`)) toast.success("Agreement removed");
  }

  return (
    <Row
      title="Data processing agreement"
      description={dpa.uploaded ? `PDF, ${Math.max(1, Math.round((dpa.size ?? 0) / 1024))} KB, uploaded ${date(dpa.uploadedAt!)}.` : "Upload your own. Vardo doesn't write it."}
      status={
        dpa.uploaded ? (
          <span className="flex items-center gap-1.5"><StatusMark tone={dpa.published ? "good" : "neutral"} pending={!dpa.published} />{dpa.published ? "Public" : "Not published"}</span>
        ) : null
      }
      actions={
        <>
          <input ref={input} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Data processing agreement PDF" onChange={(e) => void upload(e.target.files?.[0])} />
          {dpa.uploaded && (
            <>
              <Button asChild size="xs" variant="outline"><a href={`${ENDPOINT}/dpa`}>Download</a></Button>
              {dpa.published ? (
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void act("unpublish")}>Unpublish</Button>
              ) : (
                <Button size="xs" disabled={busy} onClick={() => void act("publish")}>Publish</Button>
              )}
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove()}>Remove</Button>
            </>
          )}
          <Button size="xs" variant="outline" disabled={busy} onClick={() => input.current?.click()}><Upload className="size-3.5" />{dpa.uploaded ? "Replace" : "Upload"}</Button>
        </>
      }
    />
  );
}

export function DocumentsCard({ documents, busy, call }: { documents: TrustView["documents"]; busy: boolean; call: Call }) {
  return (
    <Card id="documents" variant="surface" className="space-y-2 py-5">
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        <p className="text-sm text-muted-foreground">Vardo drafts three policies from your settings. They stay private until you review them, and a settings change marks them for review again.</p>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {documents.policies.map((p) => <PolicyRow key={`${p.id}:${p.draft.length}`} policy={p} busy={busy} call={call} />)}
          <DpaRow dpa={documents.dpa} busy={busy} call={call} />
        </ul>
      </CardContent>
    </Card>
  );
}

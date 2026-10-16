"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "@/lib/messenger";
import type { TrustView } from "@/lib/trust/view";

type Row = TrustView["subprocessors"][number];
type Call = (method: "PATCH" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) => Promise<TrustView | null>;

const ENDPOINT = "/api/v1/admin/trust/subprocessors";

function Fields({ values, onChange, onBlur, label }: { values: { name: string; purpose: string; region: string }; onChange: (next: { name: string; purpose: string; region: string }) => void; onBlur?: () => void; label: string }) {
  return (
    <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[1fr_1.4fr_0.7fr]">
      <Input aria-label={`${label} name`} placeholder="Name" value={values.name} onChange={(e) => onChange({ ...values, name: e.target.value })} onBlur={onBlur} />
      <Input aria-label={`${label} purpose`} placeholder="What it does for client data" value={values.purpose} onChange={(e) => onChange({ ...values, purpose: e.target.value })} onBlur={onBlur} />
      <Input aria-label={`${label} region`} placeholder="Region" value={values.region} onChange={(e) => onChange({ ...values, region: e.target.value })} onBlur={onBlur} />
    </div>
  );
}

function Item({ row, busy, call }: { row: Row; busy: boolean; call: Call }) {
  const [values, setValues] = useState({ name: row.name, purpose: row.purpose, region: row.region ?? "" });

  async function save() {
    const patch: Record<string, string | null> = {};
    if (values.name.trim() !== row.name) patch.name = values.name.trim();
    if (values.purpose.trim() !== row.purpose) patch.purpose = values.purpose.trim();
    if (values.region.trim() !== (row.region ?? "")) patch.region = values.region.trim() || null;
    if (Object.keys(patch).length === 0) return;
    if ((patch.name === "") || (patch.purpose === "")) {
      toast.error("Name and purpose can't be empty");
      setValues({ name: row.name, purpose: row.purpose, region: row.region ?? "" });
      return;
    }
    if (await call("PATCH", `${ENDPOINT}/${row.id}`, patch)) toast.success("Saved");
  }

  async function setStatus(status: "confirmed" | "dismissed", message: string, undo: "suggested" | "confirmed") {
    const patch = { status, ...(status === "confirmed" && { name: values.name.trim() || row.name, purpose: values.purpose.trim() || row.purpose, region: values.region.trim() || null }) };
    const saved = await call("PATCH", `${ENDPOINT}/${row.id}`, patch);
    if (saved) toast.success(message, { action: { label: "Undo", onClick: () => void call("PATCH", `${ENDPOINT}/${row.id}`, { status: undo }) } });
  }

  async function remove() {
    const saved = await call("DELETE", `${ENDPOINT}/${row.id}`);
    if (saved) toast.success(`${row.name} removed`);
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Fields values={values} onChange={setValues} onBlur={() => void save()} label={row.name} />
        <div className="flex shrink-0 items-center gap-2">
          {row.status === "suggested" ? (
            <>
              <Button size="xs" disabled={busy} onClick={() => void setStatus("confirmed", `${row.name} confirmed`, "suggested")}>Confirm</Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void setStatus("dismissed", `${row.name} dismissed`, "suggested")}>Dismiss</Button>
            </>
          ) : row.gone ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove()}>Confirm removal</Button>
          ) : (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void remove()}>Remove</Button>
          )}
        </div>
      </div>
      {row.status === "suggested" && <p className="text-xs text-muted-foreground">Found in your settings. Not on the public page until you confirm it.</p>}
      {row.gone && <p className="text-xs text-status-warning">No longer detected. Still on the public page until you confirm the removal.</p>}
    </li>
  );
}

export function SubprocessorsCard({ rows, busy, call }: { rows: Row[]; busy: boolean; call: Call }) {
  const [draft, setDraft] = useState({ name: "", purpose: "", region: "" });
  const ready = draft.name.trim() !== "" && draft.purpose.trim() !== "";

  async function add() {
    const saved = await call("POST", ENDPOINT, { name: draft.name.trim(), purpose: draft.purpose.trim(), region: draft.region.trim() || null });
    if (saved) {
      setDraft({ name: "", purpose: "", region: "" });
      toast.success("Subprocessor added");
    }
  }

  const suggested = rows.filter((r) => r.status === "suggested");
  const listed = rows.filter((r) => r.status === "confirmed");

  return (
    <Card id="subprocessors" variant="surface" className="space-y-2 py-5">
      <CardHeader>
        <CardTitle>Subprocessors</CardTitle>
        <p className="text-sm text-muted-foreground">Services that can touch client data. Vardo suggests them from your settings; only the ones you confirm are published.</p>
      </CardHeader>
      <CardContent className="space-y-1">
        {suggested.length > 0 && (
          <ul className="divide-y rounded-md bg-muted/40 px-3">
            {suggested.map((r) => <Item key={`${r.id}:${r.name}:${r.purpose}:${r.region}`} row={r} busy={busy} call={call} />)}
          </ul>
        )}
        {listed.length > 0 ? (
          <ul className="divide-y">
            {listed.map((r) => <Item key={`${r.id}:${r.name}:${r.purpose}:${r.region}`} row={r} busy={busy} call={call} />)}
          </ul>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">None confirmed. The page shows no subprocessors section.</p>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t pt-3">
          <Fields values={draft} onChange={setDraft} label="New subprocessor" />
          <Button size="sm" variant="outline" disabled={busy || !ready} onClick={() => void add()}><Plus className="size-4" />Add</Button>
        </div>
      </CardContent>
    </Card>
  );
}

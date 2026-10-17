"use client";

import { useCallback, useState } from "react";
import { ArrowUp, Loader2, ServerCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/lib/messenger";
import { buildStatsParts } from "@/lib/ui/build-placement";
import type { BuildStats } from "@/lib/docker/build-placement-stats";
import { useSystemSetting } from "./use-system-setting";

type Target = {
  id: string;
  kind: "ssh" | "mesh";
  name: string;
  host: string;
  port: number;
  user: string;
  maxConcurrent: number;
  hasKey: boolean;
  /** Pinned host key fingerprints, null until the first test. */
  hostKey: string[] | null;
  /** Linked instance only: why it can't take builds yet. */
  waiting?: string | null;
  /** Linked instance only: it builds in its isolated builder, on `port`. */
  isolated?: boolean;
  /** Builds sent there over the stats window, null when none. */
  stats?: BuildStats | null;
};

type Data = { registry: boolean; statsDays?: number; here?: BuildStats | null; targets: Target[] };

type Draft = { id?: string; mesh?: boolean; name: string; host: string; port: string; user: string; privateKey: string; maxConcurrent: string };

const EMPTY: Draft = { name: "", host: "", port: "22", user: "root", privateKey: "", maxConcurrent: "1" };

const ENDPOINT = "/api/v1/admin/build-targets";

/** Builds over the window in one place: counts, then medians. */
function BuildStatsLine({ stats, days, where }: { stats: BuildStats | null | undefined; days: number; where: "here" | "target" }) {
  const parts = buildStatsParts(stats, where);
  return (
    <div className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
      <ServerCog className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      {parts ? (
        <div className="min-w-0 space-y-0.5">
          <p>Last {days} days: {parts.counts.join(" · ")}</p>
          {parts.medians.length > 0 && <p>Median {parts.medians.join(" · ")}</p>}
        </div>
      ) : (
        <p className="min-w-0">No builds in the last {days} days</p>
      )}
    </div>
  );
}

/** Docker hosts over SSH and linked instances that builds overflow to when this server's builder is busy. */
export function BuildTargetsSettings() {
  const [data, setData] = useState<Data>({ registry: false, statsDays: 30, here: null, targets: [] });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Target | null>(null);

  const onLoad = useCallback(
    (loaded: Data) => setData({ registry: loaded.registry, statsDays: loaded.statsDays, here: loaded.here, targets: loaded.targets }),
    [],
  );
  const days = data.statsDays ?? 30;
  const { loading, saving, save, refetch } = useSystemSetting<Data>(ENDPOINT, {
    label: "Build targets",
    onLoad,
    onSaved: () => setDraft(null),
  });

  const test = async (target: Target) => {
    setTesting(target.id);
    try {
      const res = await fetch(`${ENDPOINT}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: target.id }),
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; isolated?: boolean; pinned?: boolean; fingerprints?: string[]; dockerVersion?: string; error?: string }
        | null;
      const pinned = body?.pinned ? ` Pinned host key ${body.fingerprints?.join(", ")}.` : "";
      if (body?.ok && body.isolated) toast.success(`${target.name}: its isolated builder accepted this server's certificate.`);
      else if (body?.ok) toast.success(`${target.name}: Docker ${body.dockerVersion}.${pinned}`);
      else toast.error(`${target.name}: ${body?.error ?? "test failed"}.${pinned}`);
    } finally {
      setTesting(null);
      refetch();
    }
  };

  const set = (key: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((d) => (d ? { ...d, [key]: e.target.value } : d));

  const busy = loading || saving;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Build targets</CardTitle>
        <CardDescription>
          When this server&apos;s builder is full, builds run on these targets in order. Images come back through the build
          registry when one is set, otherwise straight from the build.
          Dockerfile, Nixpacks and compose builds can run there; Railpack builds stay here. A linked instance that accepts builds
          from here joins the list on its own and builds in its isolated builder, with no access to its Docker or host.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!loading && !data.registry && data.targets.length > 0 && (
          <p className="text-sm text-muted-foreground">
            No build registry, so each image comes back whole. A registry sends only the layers that changed.
          </p>
        )}

        {data.targets.length > 0 && (
          <ul className="divide-y rounded-md border">
            <li className="p-3">
              <p className="text-sm font-medium">This server</p>
              <BuildStatsLine stats={data.here} days={days} where="here" />
            </li>
            {data.targets.map((t, i) => (
              <li key={t.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {t.name}
                    {t.kind === "mesh" && <Badge variant="outline">Linked instance</Badge>}
                  </p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {t.kind === "mesh" ? `${t.host}:${t.port}` : `${t.user}@${t.host}:${t.port}`} · {t.maxConcurrent} at a time
                  </p>
                  <p className="[overflow-wrap:anywhere] font-mono text-xs text-muted-foreground sm:truncate" title={t.hostKey?.join("\n")}>
                    {t.isolated
                      ? "Isolated builder, certificate from the mesh link"
                      : t.kind === "mesh"
                        ? `Not ready: ${t.waiting ?? "waiting for the key exchange"}`
                        : t.hostKey
                          ? `Host key ${t.hostKey.find((f) => f.endsWith("(ED25519)")) ?? t.hostKey[0]}`
                          : "Host key not pinned yet; Test pins it"}
                  </p>
                  <BuildStatsLine stats={t.stats} days={days} where="target" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy || testing !== null} onClick={() => test(t)}>
                    {testing === t.id && <Loader2 className="size-4 animate-spin" />}
                    Test
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      setDraft({
                        id: t.id,
                        mesh: t.kind === "mesh",
                        name: t.name,
                        host: t.host,
                        port: String(t.port),
                        user: t.user,
                        privateKey: "",
                        maxConcurrent: String(t.maxConcurrent),
                      })
                    }
                  >
                    Edit
                  </Button>
                  {t.hostKey && t.kind !== "mesh" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => save({ action: "forget-host-key", id: t.id })}>
                      Forget host key
                    </Button>
                  )}
                  {i > 0 && (
                    <Button size="sm" variant="outline" disabled={busy} aria-label={`Move ${t.name} up`} onClick={() => save({ action: "move", id: t.id, direction: "up" })}>
                      <ArrowUp className="size-4" />
                    </Button>
                  )}
                  {t.kind !== "mesh" && (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => setRemoving(t)}>
                      Remove
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {draft?.mesh ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save({ action: "limit", id: draft.id, maxConcurrent: draft.maxConcurrent });
            }}
          >
            <div className="max-w-xs space-y-2">
              <Label htmlFor="build-target-max">Builds at a time on {draft.name}</Label>
              <Input id="build-target-max" type="number" min={0} max={16} value={draft.maxConcurrent} onChange={set("maxConcurrent")} />
              <p className="text-xs text-muted-foreground">0 sends it no builds. Its address and keys come from the mesh link.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : draft ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save({
                action: "save",
                ...(draft.id ? { id: draft.id } : {}),
                name: draft.name,
                host: draft.host,
                port: draft.port,
                user: draft.user,
                maxConcurrent: draft.maxConcurrent,
                ...(draft.privateKey.trim() ? { privateKey: draft.privateKey } : {}),
              });
            }}
          >
            <div className="grid max-w-xl gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="build-target-name">Name</Label>
                <Input id="build-target-name" placeholder="Long House" value={draft.name} onChange={set("name")} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="build-target-max">Builds at a time</Label>
                <Input id="build-target-max" type="number" min={0} max={16} value={draft.maxConcurrent} onChange={set("maxConcurrent")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="build-target-host">Host</Label>
                <Input id="build-target-host" placeholder="10.99.0.2" value={draft.host} onChange={set("host")} autoComplete="off" spellCheck={false} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="build-target-port">Port</Label>
                  <Input id="build-target-port" type="number" min={1} max={65535} value={draft.port} onChange={set("port")} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="build-target-user">User</Label>
                  <Input id="build-target-user" value={draft.user} onChange={set("user")} autoComplete="off" spellCheck={false} />
                </div>
              </div>
            </div>
            <div className="max-w-xl space-y-2">
              <Label htmlFor="build-target-key">SSH private key</Label>
              <Textarea
                id="build-target-key"
                className="font-mono text-xs"
                rows={5}
                placeholder={draft.id ? "Saved. Paste a new key to replace it." : "-----BEGIN OPENSSH PRIVATE KEY-----"}
                value={draft.privateKey}
                onChange={set("privateKey")}
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                The user needs to run docker on that host. Test pins the host&apos;s SSH key; builds refuse any other.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || !draft.host.trim() || !draft.user.trim() || (!draft.id && !draft.privateKey.trim())}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                Save
              </Button>
              <Button type="button" variant="outline" disabled={saving} onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="outline" disabled={busy} onClick={() => setDraft(EMPTY)}>
            Add target
          </Button>
        )}

        <ConfirmDeleteDialog
          open={removing !== null}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={`Remove ${removing?.name ?? "target"}?`}
          description="Builds stop going to it. Builds running there finish."
          confirmLabel="Remove"
          loading={saving}
          onConfirm={() => {
            if (removing) save({ action: "remove", id: removing.id });
            setRemoving(null);
          }}
        />
      </CardContent>
    </Card>
  );
}

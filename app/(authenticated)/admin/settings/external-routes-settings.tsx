"use client";

import { useState, useEffect } from "react";
import {
  Loader2,
  Plus,
  MoreHorizontal,
  Trash2,
  Pencil,
  Globe,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ConfirmDeleteDialog } from "@/components/ui/confirm-delete-dialog";
import { toast } from "@/lib/messenger";

type ExternalRoute = {
  id: string;
  hostname: string;
  targetUrl: string | null;
  tls: boolean;
  insecureSkipVerify: boolean;
  redirectUrl: string | null;
  redirectPermanent: boolean;
  createdAt: string;
  updatedAt: string;
};

type RouteFormState = {
  hostname: string;
  targetUrl: string;
  tls: boolean;
  insecureSkipVerify: boolean;
  redirectUrl: string;
  redirectPermanent: boolean;
};

const defaultForm: RouteFormState = {
  hostname: "",
  targetUrl: "",
  tls: false,
  insecureSkipVerify: false,
  redirectUrl: "",
  redirectPermanent: false,
};

function routeToForm(route: ExternalRoute): RouteFormState {
  return {
    hostname: route.hostname,
    targetUrl: route.targetUrl ?? "",
    tls: route.tls,
    insecureSkipVerify: route.insecureSkipVerify,
    redirectUrl: route.redirectUrl ?? "",
    redirectPermanent: route.redirectPermanent,
  };
}

export function ExternalRoutesSettings() {
  const [routes, setRoutes] = useState<ExternalRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<RouteFormState>(defaultForm);
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Edit dialog
  const [editTarget, setEditTarget] = useState<ExternalRoute | null>(null);
  const [editForm, setEditForm] = useState<RouteFormState>(defaultForm);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete dialog
  const [deleteTarget, setDeleteTarget] = useState<ExternalRoute | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchRoutes() {
    try {
      const res = await fetch("/api/v1/admin/external-routes");
      if (!res.ok) throw new Error("Failed to load");
      const json = await res.json();
      setRoutes(json.routes ?? []);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchRoutes();
  }, []);

  function handleOpenEdit(route: ExternalRoute) {
    setEditTarget(route);
    setEditForm(routeToForm(route));
    setEditError(null);
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddSaving(true);
    setAddError(null);
    try {
      const body = {
        hostname: addForm.hostname.trim(),
        tls: addForm.tls,
        insecureSkipVerify: addForm.insecureSkipVerify,
        redirectPermanent: addForm.redirectPermanent,
        ...(addForm.redirectUrl.trim()
          ? { redirectUrl: addForm.redirectUrl.trim() }
          : { targetUrl: addForm.targetUrl.trim() }),
      };

      const res = await fetch("/api/v1/admin/external-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setAddError(json.error || "Failed to create route");
        return;
      }
      setRoutes((prev) => [...prev, json.route].sort((a, b) => a.hostname.localeCompare(b.hostname)));
      toast.success(`Route for ${json.route.hostname} created`);
      setAddOpen(false);
      setAddForm(defaultForm);
    } catch {
      setAddError("Failed to create route");
    } finally {
      setAddSaving(false);
    }
  }

  async function handleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editTarget) return;
    setEditSaving(true);
    setEditError(null);
    try {
      const body = {
        hostname: editForm.hostname.trim(),
        tls: editForm.tls,
        insecureSkipVerify: editForm.insecureSkipVerify,
        redirectPermanent: editForm.redirectPermanent,
        redirectUrl: editForm.redirectUrl.trim() || null,
        targetUrl: editForm.targetUrl.trim(),
      };

      const res = await fetch(`/api/v1/admin/external-routes/${editTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setEditError(json.error || "Failed to update route");
        return;
      }
      setRoutes((prev) =>
        prev
          .map((r) => (r.id === editTarget.id ? json.route : r))
          .sort((a, b) => a.hostname.localeCompare(b.hostname))
      );
      toast.success(`Route for ${json.route.hostname} updated`);
      setEditTarget(null);
    } catch {
      setEditError("Failed to update route");
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/v1/admin/external-routes/${deleteTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const json = await res.json();
        toast.error(json.error || "Failed to delete route");
        return;
      }
      setRoutes((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      toast.success(`Route for ${deleteTarget.hostname} deleted`);
    } catch {
      toast.error("Failed to delete route");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8" role="status" aria-live="polite">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
        <span className="sr-only">Loading external routes</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">Unable to load external routes.</p>
        <Button variant="outline" className="squircle" onClick={() => { setLoading(true); fetchRoutes(); }}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-medium">External routes</h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Route subdomains to non-Docker services running on arbitrary IP:port targets.
            Traefik will proxy or redirect traffic for each hostname you define here.
          </p>
        </div>
        <Button
          size="sm"
          className="squircle"
          onClick={() => {
            setAddForm(defaultForm);
            setAddError(null);
            setAddOpen(true);
          }}
        >
          <Plus className="size-4" />
          Add route
        </Button>
      </div>

      {/* Route list */}
      {routes.length === 0 ? (
        <Card className="squircle rounded-lg">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Globe className="size-10 text-muted-foreground/50 mb-3" aria-hidden="true" />
            <p className="text-sm font-medium">No external routes defined</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add a route to proxy a subdomain to an external service.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card className="squircle rounded-lg">
          <CardContent className="p-0">
            <div className="divide-y">
              {routes.map((route) => (
                <div
                  key={route.id}
                  className="flex items-center justify-between gap-4 px-6 py-4"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium font-mono truncate">
                        {route.hostname}
                      </p>
                      {route.tls && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          TLS
                        </Badge>
                      )}
                      {route.insecureSkipVerify && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-yellow-600 border-yellow-400/50">
                          skip verify
                        </Badge>
                      )}
                      {route.redirectUrl && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          {route.redirectPermanent ? "301" : "302"} redirect
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {route.redirectUrl ? (
                        <>
                          <ExternalLink className="inline size-3 mr-1" aria-hidden="true" />
                          {route.redirectUrl}
                        </>
                      ) : (
                        route.targetUrl
                      )}
                    </p>
                  </div>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="size-8 p-0 shrink-0"
                        aria-label={`Actions for ${route.hostname}`}
                      >
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="squircle">
                      <DropdownMenuItem onClick={() => handleOpenEdit(route)}>
                        <Pencil className="size-4" />
                        Edit
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => setDeleteTarget(route)}
                      >
                        <Trash2 className="size-4" />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add route dialog */}
      <Dialog open={addOpen} onOpenChange={(open) => { if (!addSaving) setAddOpen(open); }}>
        <DialogContent className="squircle sm:max-w-lg">
          <form onSubmit={handleAdd}>
            <DialogHeader>
              <DialogTitle>Add external route</DialogTitle>
              <DialogDescription>
                Route a hostname to an external service. Use target URL for proxy or
                redirect URL to forward requests elsewhere.
              </DialogDescription>
            </DialogHeader>
            <RouteFormFields
              form={addForm}
              onChange={setAddForm}
              error={addError}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="squircle"
                disabled={addSaving}
                onClick={() => setAddOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="squircle" disabled={addSaving}>
                {addSaving && <Loader2 className="size-4 animate-spin" />}
                Add route
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit route dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(open) => { if (!editSaving && !open) setEditTarget(null); }}
      >
        <DialogContent className="squircle sm:max-w-lg">
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>Edit external route</DialogTitle>
              <DialogDescription>
                Update the route configuration. Changes take effect immediately.
              </DialogDescription>
            </DialogHeader>
            <RouteFormFields
              form={editForm}
              onChange={setEditForm}
              error={editError}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="squircle"
                disabled={editSaving}
                onClick={() => setEditTarget(null)}
              >
                Cancel
              </Button>
              <Button type="submit" className="squircle" disabled={editSaving}>
                {editSaving && <Loader2 className="size-4 animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDeleteDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete external route"
        description={`Delete the route for "${deleteTarget?.hostname}"? Traefik will stop routing traffic for this hostname immediately.`}
        onConfirm={handleDelete}
        loading={deleting}
        confirmLabel="Delete"
        loadingLabel="Deleting..."
      />
    </div>
  );
}

type RouteFormFieldsProps = {
  form: RouteFormState;
  onChange: React.Dispatch<React.SetStateAction<RouteFormState>>;
  error: string | null;
};

function RouteFormFields({ form, onChange, error }: RouteFormFieldsProps) {
  const isRedirect = form.redirectUrl.trim().length > 0;

  return (
    <div className="space-y-4 py-4">
      <div className="space-y-2">
        <Label htmlFor="hostname">Hostname</Label>
        <Input
          id="hostname"
          value={form.hostname}
          onChange={(e) => onChange((prev) => ({ ...prev, hostname: e.target.value }))}
          placeholder="app.example.com"
          className="font-mono"
          required
          autoFocus
        />
        <p className="text-xs text-muted-foreground">
          The subdomain or domain Traefik should listen on.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="targetUrl">Target URL</Label>
        <Input
          id="targetUrl"
          value={form.targetUrl}
          onChange={(e) => onChange((prev) => ({ ...prev, targetUrl: e.target.value }))}
          placeholder="http://192.168.1.10:8080"
          className="font-mono"
          disabled={isRedirect}
          required={!isRedirect}
        />
        <p className="text-xs text-muted-foreground">
          The upstream service URL. Leave empty if using a redirect instead. Only point external routes at services you own.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="redirectUrl">Redirect URL (optional)</Label>
        <Input
          id="redirectUrl"
          value={form.redirectUrl}
          onChange={(e) => onChange((prev) => ({ ...prev, redirectUrl: e.target.value }))}
          placeholder="https://other.example.com"
          className="font-mono"
        />
        <p className="text-xs text-muted-foreground">
          When set, requests are redirected instead of proxied. Target URL is ignored.
        </p>
      </div>

      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="space-y-0.5">
          <Label htmlFor="tls" className="text-sm font-normal">
            Enable TLS
          </Label>
          <p className="text-xs text-muted-foreground">
            Issue a certificate for this hostname using the configured certificate authority.
          </p>
        </div>
        <Switch
          id="tls"
          checked={form.tls}
          onCheckedChange={(checked) => onChange((prev) => ({ ...prev, tls: checked }))}
          aria-label={`${form.tls ? "Disable" : "Enable"} TLS`}
        />
      </div>

      {!isRedirect && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="insecureSkipVerify" className="text-sm font-normal">
              Skip TLS verification
            </Label>
            <p className="text-xs text-muted-foreground">
              Disable certificate verification when the target uses a self-signed cert.
            </p>
          </div>
          <Switch
            id="insecureSkipVerify"
            checked={form.insecureSkipVerify}
            onCheckedChange={(checked) =>
              onChange((prev) => ({ ...prev, insecureSkipVerify: checked }))
            }
            aria-label={`${form.insecureSkipVerify ? "Disable" : "Enable"} TLS skip verify`}
          />
        </div>
      )}

      {isRedirect && (
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="redirectPermanent" className="text-sm font-normal">
              Permanent redirect
            </Label>
            <p className="text-xs text-muted-foreground">
              Use 301 (permanent) instead of 302 (temporary).
            </p>
          </div>
          <Switch
            id="redirectPermanent"
            checked={form.redirectPermanent}
            onCheckedChange={(checked) =>
              onChange((prev) => ({ ...prev, redirectPermanent: checked }))
            }
            aria-label={`${form.redirectPermanent ? "Use temporary" : "Use permanent"} redirect`}
          />
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}

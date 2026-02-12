"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  Plus,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  BottomSheet,
  BottomSheetContent,
  BottomSheetHeader,
  BottomSheetTitle,
  BottomSheetFooter,
} from "@/components/ui/bottom-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

type ScopeClient = {
  id: string;
  name: string;
  token: string;
  domains: string[];
  publicAccess: boolean;
  enabled: boolean;
  defaultProjectId: string | null;
  defaultProject: { id: string; name: string } | null;
  createdAt: string;
  stats?: {
    heartbeatCount: number;
    lastSeen: string | null;
  };
};

type Project = {
  id: string;
  name: string;
};

type ScopeClientPanelProps = {
  clientId: string;
  orgId: string;
  projects: Project[];
};

export function ScopeClientPanel({ clientId, orgId, projects }: ScopeClientPanelProps) {
  const [scopeClients, setScopeClients] = useState<ScopeClient[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState("");
  const [formProjectId, setFormProjectId] = useState("");
  const [formDomains, setFormDomains] = useState("");
  const [formPublicAccess, setFormPublicAccess] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const fetchScopeClients = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/scope-clients?clientId=${clientId}`
      );
      if (res.ok) {
        const data = await res.json();
        setScopeClients(data);
      }
    } catch (err) {
      console.error("Error fetching scope clients:", err);
    } finally {
      setIsLoading(false);
    }
  }, [orgId, clientId]);

  useEffect(() => {
    fetchScopeClients();
  }, [fetchScopeClients]);

  const handleCreate = async () => {
    if (!formName.trim()) {
      toast.error("Name is required");
      return;
    }

    setIsSaving(true);
    try {
      const domains = formDomains
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);

      const res = await fetch(`/api/v1/organizations/${orgId}/scope-clients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formName.trim(),
          clientId,
          defaultProjectId: formProjectId || null,
          domains,
          publicAccess: formPublicAccess,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to create");
        return;
      }

      const created = await res.json();
      setCreatedToken(created.token);
      toast.success("Scope Client created");
      fetchScopeClients();
      // Reset form but keep dialog open to show token
      setFormName("");
      setFormProjectId("");
      setFormDomains("");
      setFormPublicAccess(false);
    } catch {
      toast.error("Failed to create");
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleEnabled = async (sc: ScopeClient) => {
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/scope-clients/${sc.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !sc.enabled }),
        }
      );

      if (res.ok) {
        setScopeClients((prev) =>
          prev.map((s) =>
            s.id === sc.id ? { ...s, enabled: !s.enabled } : s
          )
        );
        toast.success(sc.enabled ? "Disabled" : "Enabled");
      }
    } catch {
      toast.error("Failed to update");
    }
  };

  const handleDelete = async (scId: string) => {
    if (!confirm("Delete this Scope Client? This will also delete all heartbeat data.")) return;

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/scope-clients/${scId}`,
        { method: "DELETE" }
      );

      if (res.ok) {
        setScopeClients((prev) => prev.filter((s) => s.id !== scId));
        toast.success("Deleted");
      }
    } catch {
      toast.error("Failed to delete");
    }
  };

  const copyToken = (token: string) => {
    navigator.clipboard.writeText(token);
    setCopiedToken(token);
    setTimeout(() => setCopiedToken(null), 2000);
  };

  const maskToken = (token: string) => {
    if (token.length <= 8) return token;
    return token.slice(0, 6) + "\u2022".repeat(8) + token.slice(-4);
  };

  const apiUrl = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <Card className="squircle">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <Globe className="size-5" />
          Connected Sites
        </CardTitle>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setCreatedToken(null);
            setDialogOpen(true);
          }}
          className="squircle"
        >
          <Plus className="size-4" />
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : scopeClients.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No connected sites. Add a Scope Client to embed the widget on a
            client site.
          </p>
        ) : (
          <div className="space-y-3">
            {scopeClients.map((sc) => (
              <div
                key={sc.id}
                className="squircle flex items-center justify-between gap-4 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{sc.name}</span>
                    {!sc.enabled && (
                      <Badge variant="secondary" className="text-xs">
                        Disabled
                      </Badge>
                    )}
                    {sc.publicAccess && (
                      <Badge variant="outline" className="text-xs">
                        Public
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <code className="text-xs text-muted-foreground font-mono">
                      {maskToken(sc.token)}
                    </code>
                    <button
                      onClick={() => copyToken(sc.token)}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {copiedToken === sc.token ? (
                        <Check className="size-3" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </button>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                    {sc.defaultProject && (
                      <span>Project: {sc.defaultProject.name}</span>
                    )}
                    {sc.domains && sc.domains.length > 0 && (
                      <span>{sc.domains.join(", ")}</span>
                    )}
                    {sc.stats?.lastSeen && (
                      <span>
                        Last seen:{" "}
                        {new Date(sc.stats.lastSeen).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={sc.enabled}
                    onCheckedChange={() => handleToggleEnabled(sc)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => handleDelete(sc.id)}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Create dialog */}
      <BottomSheet open={dialogOpen} onOpenChange={setDialogOpen}>
        <BottomSheetContent className="squircle">
          <BottomSheetHeader>
            <BottomSheetTitle>
              {createdToken ? "Scope Client Created" : "Add Scope Client"}
            </BottomSheetTitle>
          </BottomSheetHeader>

          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {createdToken ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Copy the embed code below and add it to your client's site.
                  The token is shown once — copy it now.
                </p>
                <div className="rounded-lg bg-muted p-3 font-mono text-xs break-all">
                  {`<script src="${apiUrl}/widget/scope.js" data-key="${createdToken}"></script>`}
                </div>
                <Button
                  className="squircle w-full"
                  onClick={() => {
                    navigator.clipboard.writeText(
                      `<script src="${apiUrl}/widget/scope.js" data-key="${createdToken}"></script>`
                    );
                    toast.success("Copied to clipboard");
                  }}
                >
                  <Copy className="size-4" />
                  Copy Embed Code
                </Button>
                <Button
                  variant="outline"
                  className="squircle w-full"
                  onClick={() => {
                    setCreatedToken(null);
                    setDialogOpen(false);
                  }}
                >
                  Done
                </Button>
              </div>
            ) : (
              <>
                <div className="space-y-4">
                  <div>
                    <Label>Name</Label>
                    <Input
                      placeholder="e.g., Acme Corp Production"
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      className="squircle"
                    />
                  </div>

                  <div>
                    <Label>Default Project</Label>
                    <Select value={formProjectId} onValueChange={setFormProjectId}>
                      <SelectTrigger className="squircle">
                        <SelectValue placeholder="Select project..." />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground mt-1">
                      Bug reports will be routed to this project.
                    </p>
                  </div>

                  <div>
                    <Label>Allowed Domains</Label>
                    <Input
                      placeholder="example.com, staging.example.com"
                      value={formDomains}
                      onChange={(e) => setFormDomains(e.target.value)}
                      className="squircle"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Comma-separated. Leave empty to allow any domain.
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <Label>Public Access</Label>
                      <p className="text-xs text-muted-foreground">
                        Allow anonymous users to submit bug reports
                      </p>
                    </div>
                    <Switch
                      checked={formPublicAccess}
                      onCheckedChange={setFormPublicAccess}
                    />
                  </div>
                </div>

                <BottomSheetFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDialogOpen(false)}
                    className="squircle"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreate}
                    disabled={isSaving}
                    className="squircle"
                  >
                    {isSaving && <Loader2 className="size-4 animate-spin" />}
                    Create
                  </Button>
                </BottomSheetFooter>
              </>
            )}
          </div>
        </BottomSheetContent>
      </BottomSheet>
    </Card>
  );
}

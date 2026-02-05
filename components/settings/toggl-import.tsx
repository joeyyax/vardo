"use client";

import { useState, useCallback } from "react";
import {
  ArrowRight,
  Check,
  Loader2,
  Upload,
  X,
  ArrowDownToLine,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Workspace = {
  id: number;
  name: string;
};

type TogglClient = {
  id: number;
  name: string;
};

type ExistingClient = {
  id: string;
  name: string;
  color: string | null;
};

type ClientMapping = {
  togglId: number;
  togglName: string;
  action: "create" | "map" | "skip";
  targetClientId?: string;
};

type PreviewData = {
  workspace: Workspace;
  counts: {
    clients: number;
    projects: number;
    entries: number;
  };
  dateRange: {
    from: string;
    to: string;
  };
  togglClients: TogglClient[];
  existingClients: ExistingClient[];
  suggestedMappings: Array<{
    togglId: number;
    togglName: string;
    suggestedAction: string;
    suggestedTargetId?: string;
    suggestedTargetName?: string;
  }>;
};

type ImportResult = {
  clientsCreated: number;
  clientsMapped: number;
  projectsCreated: number;
  entriesImported: number;
  entriesSkipped: number;
  errors: string[];
};

type Step = "connect" | "preview" | "mapping" | "importing" | "complete";

type TogglImportProps = {
  orgId: string;
};

// Helper to format date as YYYY-MM-DD
function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export function TogglImport({ orgId }: TogglImportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("connect");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Connect step
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<number | null>(
    null
  );

  // Date range - default to 90 days (Toggl API limit)
  const [dateFrom, setDateFrom] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() - 89);
    return formatDate(date);
  });
  const [dateTo, setDateTo] = useState(() => formatDate(new Date()));

  // Preview step
  const [preview, setPreview] = useState<PreviewData | null>(null);

  // Mapping step
  const [clientMappings, setClientMappings] = useState<ClientMapping[]>([]);

  // Import result
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = useCallback(() => {
    setStep("connect");
    setToken("");
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
    setPreview(null);
    setClientMappings([]);
    setResult(null);
    setError(null);
    // Reset date range to 90 days (Toggl API limit)
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 89);
    setDateFrom(formatDate(ninetyDaysAgo));
    setDateTo(formatDate(new Date()));
  }, []);

  const handleConnect = async () => {
    if (!token.trim()) {
      setError("Please enter your Toggl API token");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to connect");
      }

      setWorkspaces(data.workspaces);
      if (data.defaultWorkspaceId) {
        setSelectedWorkspaceId(data.defaultWorkspaceId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePreview = async () => {
    if (!selectedWorkspaceId) {
      setError("Please select a workspace");
      return;
    }

    if (!dateFrom || !dateTo) {
      setError("Please select a date range");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            workspaceId: selectedWorkspaceId,
            dateRange: { from: dateFrom, to: dateTo },
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to preview import");
      }

      setPreview(data);

      // Initialize mappings from suggestions
      const mappings: ClientMapping[] = data.suggestedMappings.map(
        (s: PreviewData["suggestedMappings"][0]) => ({
          togglId: s.togglId,
          togglName: s.togglName,
          action: s.suggestedAction as "create" | "map" | "skip",
          targetClientId: s.suggestedTargetId,
        })
      );
      setClientMappings(mappings);

      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (!selectedWorkspaceId || !preview) return;

    setIsLoading(true);
    setError(null);
    setStep("importing");

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token,
            workspaceId: selectedWorkspaceId,
            dateRange: preview.dateRange,
            clientMappings,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Import failed");
      }

      setResult(data.result);
      setStep("complete");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStep("mapping");
    } finally {
      setIsLoading(false);
    }
  };

  const updateMapping = (togglId: number, updates: Partial<ClientMapping>) => {
    setClientMappings((prev) =>
      prev.map((m) => (m.togglId === togglId ? { ...m, ...updates } : m))
    );
  };

  return (
    <Card className="squircle">
      <CardHeader
        className="cursor-pointer hover:bg-muted/50 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <ArrowDownToLine className="size-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">Import via API</CardTitle>
              <CardDescription>
                Quick setup with API token. Limited to last 90 days per Toggl&apos;s API.
              </CardDescription>
            </div>
          </div>
          <ChevronRight
            className={`size-5 text-muted-foreground transition-transform ${
              isOpen ? "rotate-90" : ""
            }`}
          />
        </div>
      </CardHeader>

      {isOpen && (
        <CardContent className="space-y-4 pt-0">
            {error && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* Step: Connect */}
            {step === "connect" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="toggl-token">Toggl API Token</Label>
                  <Input
                    id="toggl-token"
                    type="password"
                    placeholder="Your Toggl API token"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="squircle"
                  />
                  <p className="text-xs text-muted-foreground">
                    Find your token at{" "}
                    <a
                      href="https://track.toggl.com/profile"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      Toggl Profile → API Token
                    </a>
                  </p>
                </div>

                {workspaces.length > 0 && (
                  <>
                    <div className="space-y-2">
                      <Label>Select Workspace</Label>
                      <Select
                        value={selectedWorkspaceId?.toString() || ""}
                        onValueChange={(v) =>
                          setSelectedWorkspaceId(parseInt(v, 10))
                        }
                      >
                        <SelectTrigger className="squircle">
                          <SelectValue placeholder="Choose a workspace" />
                        </SelectTrigger>
                        <SelectContent className="squircle">
                          {workspaces.map((ws) => (
                            <SelectItem key={ws.id} value={ws.id.toString()}>
                              {ws.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>Date Range</Label>
                      <div className="flex gap-2 items-center">
                        <Input
                          type="date"
                          value={dateFrom}
                          onChange={(e) => setDateFrom(e.target.value)}
                          className="squircle"
                        />
                        <span className="text-muted-foreground">to</span>
                        <Input
                          type="date"
                          value={dateTo}
                          onChange={(e) => setDateTo(e.target.value)}
                          className="squircle"
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Toggl limits exports to the last 90 days.
                      </p>
                    </div>
                  </>
                )}

                <div className="flex justify-end gap-2">
                  {workspaces.length === 0 ? (
                    <Button
                      onClick={handleConnect}
                      disabled={isLoading || !token.trim()}
                      className="squircle"
                    >
                      {isLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ArrowRight className="size-4" />
                      )}
                      Connect
                    </Button>
                  ) : (
                    <Button
                      onClick={handlePreview}
                      disabled={isLoading || !selectedWorkspaceId}
                      className="squircle"
                    >
                      {isLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <ArrowRight className="size-4" />
                      )}
                      Preview Import
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Step: Preview & Mapping */}
            {(step === "preview" || step === "mapping") && preview && (
              <div className="space-y-4">
                {/* Summary */}
                <div className="rounded-lg border p-4 space-y-3">
                  <h4 className="font-medium">Import Summary</h4>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <div className="text-2xl font-bold">
                        {preview.counts.clients}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Clients
                      </div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold">
                        {preview.counts.projects}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Projects
                      </div>
                    </div>
                    <div>
                      <div className="text-2xl font-bold">
                        {preview.counts.entries}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Entries
                      </div>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground text-center">
                    Date range: {preview.dateRange.from} to{" "}
                    {preview.dateRange.to}
                  </p>
                </div>

                {/* Client Mappings */}
                {clientMappings.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="font-medium">Client Mapping</h4>
                    <p className="text-sm text-muted-foreground">
                      Choose how to handle each Toggl client
                    </p>
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {clientMappings.map((mapping) => (
                        <div
                          key={mapping.togglId}
                          className="flex items-center gap-3 p-2 rounded-lg border"
                        >
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium truncate">
                              {mapping.togglName}
                            </span>
                          </div>
                          <Select
                            value={
                              mapping.action === "map"
                                ? `map:${mapping.targetClientId}`
                                : mapping.action
                            }
                            onValueChange={(v) => {
                              if (v === "create" || v === "skip") {
                                updateMapping(mapping.togglId, {
                                  action: v,
                                  targetClientId: undefined,
                                });
                              } else if (v.startsWith("map:")) {
                                updateMapping(mapping.togglId, {
                                  action: "map",
                                  targetClientId: v.replace("map:", ""),
                                });
                              }
                            }}
                          >
                            <SelectTrigger className="squircle w-[180px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="squircle">
                              <SelectItem value="create">
                                Create new client
                              </SelectItem>
                              <SelectItem value="skip">Skip</SelectItem>
                              {preview.existingClients.map((client) => (
                                <SelectItem
                                  key={client.id}
                                  value={`map:${client.id}`}
                                >
                                  Map to: {client.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex justify-between">
                  <Button
                    variant="outline"
                    onClick={reset}
                    className="squircle"
                  >
                    <X className="size-4" />
                    Cancel
                  </Button>
                  <Button
                    onClick={handleImport}
                    disabled={isLoading}
                    className="squircle"
                  >
                    {isLoading ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Upload className="size-4" />
                    )}
                    Start Import
                  </Button>
                </div>
              </div>
            )}

            {/* Step: Importing */}
            {step === "importing" && (
              <div className="flex flex-col items-center justify-center py-8 gap-4">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="text-muted-foreground">
                  Importing your data from Toggl...
                </p>
              </div>
            )}

            {/* Step: Complete */}
            {step === "complete" && result && (
              <div className="space-y-4">
                <div className="flex flex-col items-center justify-center py-4 gap-2">
                  <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
                    <Check className="size-6 text-emerald-600 dark:text-emerald-400" />
                  </div>
                  <h4 className="font-medium">Import Complete</h4>
                </div>

                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Clients created
                    </span>
                    <span className="font-medium">{result.clientsCreated}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Clients mapped
                    </span>
                    <span className="font-medium">{result.clientsMapped}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Projects created
                    </span>
                    <span className="font-medium">
                      {result.projectsCreated}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Entries imported
                    </span>
                    <span className="font-medium">
                      {result.entriesImported}
                    </span>
                  </div>
                  {result.entriesSkipped > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">
                        Entries skipped
                      </span>
                      <span className="font-medium text-amber-600">
                        {result.entriesSkipped}
                      </span>
                    </div>
                  )}
                </div>

                {result.errors.length > 0 && (
                  <div className="rounded-lg border border-amber-500/50 bg-amber-50 dark:bg-amber-950/30 p-3">
                    <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      Some items had issues:
                    </p>
                    <ul className="mt-1 text-xs text-amber-700 dark:text-amber-300 list-disc list-inside">
                      {result.errors.slice(0, 5).map((err, i) => (
                        <li key={i}>{err}</li>
                      ))}
                      {result.errors.length > 5 && (
                        <li>...and {result.errors.length - 5} more</li>
                      )}
                    </ul>
                  </div>
                )}

                <div className="flex justify-end">
                  <Button onClick={reset} className="squircle">
                    Done
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
      )}
    </Card>
  );
}

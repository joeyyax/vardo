"use client";

import { useState, useEffect, useCallback } from "react";
import { unzipSync, strFromU8 } from "fflate";
import {
  Check,
  Loader2,
  Upload,
  X,
  FileSpreadsheet,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  ArrowRight,
  RotateCcw,
  Key,
  Wand2,
  FileArchive,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";

type ImportSource = "toggl_api" | "toggl_workspace" | "toggl_entries";

type Workspace = {
  id: number;
  name: string;
};

type ClientMapping = {
  sourceName: string;
  targetId: string | null;
  targetName: string;
  confidence: number;
  confirmed: boolean;
};

type ImportSession = {
  id: string;
  source: string;
  status: string;
  currentStep: string;
  clientMappings: ClientMapping[] | null;
  projectMappings: Array<{
    sourceName: string;
    sourceCode: string | null;
    clientName: string;
    confirmed: boolean;
  }> | null;
  totalRows: number | null;
  processedRows: number | null;
  result: {
    clientsCreated: number;
    projectsCreated: number;
    tasksCreated: number;
    entriesImported: number;
    entriesSkipped: number;
    errors: string[];
  } | null;
  createdAt: string;
  updatedAt: string;
};

type ExistingClient = {
  id: string;
  name: string;
};

type ImportWizardProps = {
  orgId: string;
};

export function ImportWizard({ orgId }: ImportWizardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ImportSession | null>(null);
  const [checkingPending, setCheckingPending] = useState(true);

  // Wizard step: "intro" | "source" | "toggl_connect" | "toggl_workspace_select" | "workspace_upload" | "mapping" | "entries_prompt" | "entries_upload" | "complete"
  const [wizardStep, setWizardStep] = useState<string>("intro");

  // Source selection
  const [source, setSource] = useState<ImportSource | null>(null);

  // Toggl API state
  const [togglToken, setTogglToken] = useState("");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<number | null>(null);
  const [dateRange, setDateRange] = useState({
    from: new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
    to: new Date().toISOString().split("T")[0],
  });

  // Combined upload state
  const [uploadedFiles, setUploadedFiles] = useState<{
    workspaceZip: string | null;
    entriesCsvs: string[];
    fileNames: string[];
    entryCount: number;
  }>({ workspaceZip: null, entriesCsvs: [], fileNames: [], entryCount: 0 });
  const [parsedWorkspace, setParsedWorkspace] = useState<{
    clients: unknown[];
    projects: unknown[];
  } | null>(null);

  // Import session state
  const [session, setSession] = useState<ImportSession | null>(null);
  const [existingClients, setExistingClients] = useState<ExistingClient[]>([]);

  // Current client being reviewed
  const [currentClientIndex, setCurrentClientIndex] = useState(0);

  // Check for pending imports on mount
  useEffect(() => {
    checkPendingImports();
  }, [orgId]);

  const checkPendingImports = async () => {
    setCheckingPending(true);
    try {
      const response = await fetch(`/api/v1/organizations/${orgId}/imports`);
      const data = await response.json();
      if (data.sessions?.length > 0) {
        setPendingImport(data.sessions[0]);
      } else {
        setPendingImport(null);
      }
    } catch {
      // Ignore errors
    } finally {
      setCheckingPending(false);
    }
  };

  const openWizard = () => {
    setIsOpen(true);
    setWizardStep("intro");
  };

  const resumeImport = async () => {
    if (!pendingImport) return;

    setIsOpen(true);
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/imports/${pendingImport.id}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to load import");
      }

      setSession(data.session);
      setExistingClients(data.existingClients || []);
      setWizardStep("mapping");

      // Find first unconfirmed client
      const mappings = data.session.clientMappings || [];
      const firstUnconfirmed = mappings.findIndex(
        (m: ClientMapping) => !m.confirmed
      );
      setCurrentClientIndex(firstUnconfirmed >= 0 ? firstUnconfirmed : 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load import");
    } finally {
      setIsLoading(false);
    }
  };

  const reset = useCallback(() => {
    setWizardStep("intro");
    setSource(null);
    setTogglToken("");
    setWorkspaces([]);
    setSelectedWorkspace(null);
    setSession(null);
    setUploadedFiles({ workspaceZip: null, entriesCsvs: [], fileNames: [], entryCount: 0 });
    setParsedWorkspace(null);
    setCurrentClientIndex(0);
    setError(null);
  }, []);

  const closeWizard = () => {
    setIsOpen(false);
    // If completed, refresh pending status
    if (session?.status === "completed") {
      checkPendingImports();
      reset();
    }
  };

  // Toggl API: Connect and fetch workspaces
  const connectToggl = async () => {
    if (!togglToken) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: togglToken }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to connect to Toggl");
      }

      setWorkspaces(data.workspaces || []);
      if (data.workspaces?.length === 1) {
        setSelectedWorkspace(data.workspaces[0].id);
      }
      setWizardStep("toggl_workspace_select");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to Toggl");
    } finally {
      setIsLoading(false);
    }
  };

  // Toggl API: Fetch data and start import session
  const fetchTogglData = async () => {
    if (!togglToken || !selectedWorkspace) return;

    setIsLoading(true);
    setError(null);

    try {
      const previewResponse = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: togglToken,
            workspaceId: selectedWorkspace,
            dateRange,
          }),
        }
      );

      const previewData = await previewResponse.json();

      if (!previewResponse.ok) {
        throw new Error(previewData.error || "Failed to fetch Toggl data");
      }

      const response = await fetch(`/api/v1/organizations/${orgId}/imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "toggl_api",
          rawData: JSON.stringify({
            token: togglToken,
            workspaceId: selectedWorkspace,
            dateRange,
            preview: previewData,
          }),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to start import");
      }

      setSession(data.session);

      const clientsResponse = await fetch(
        `/api/v1/organizations/${orgId}/imports/${data.session.id}`
      );
      const clientsData = await clientsResponse.json();
      setExistingClients(clientsData.existingClients || []);

      const mappings = data.session.clientMappings || [];
      const firstUnconfirmed = mappings.findIndex(
        (m: ClientMapping) => !m.confirmed
      );
      setCurrentClientIndex(firstUnconfirmed >= 0 ? firstUnconfirmed : 0);
      setWizardStep("mapping");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch Toggl data");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFilesSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setError(null);
    const fileNames: string[] = [];
    const entriesCsvs: string[] = [];
    let workspaceData: { clients: unknown[]; projects: unknown[] } | null = null;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      fileNames.push(file.name);

      if (file.name.endsWith(".zip")) {
        // Parse zip file for workspace data
        try {
          const arrayBuffer = await file.arrayBuffer();
          const uint8Array = new Uint8Array(arrayBuffer);
          const unzipped = unzipSync(uint8Array);

          let clientsData: unknown[] = [];
          let projectsData: unknown[] = [];

          for (const [path, data] of Object.entries(unzipped)) {
            const fileName = path.split("/").pop()?.toLowerCase();
            if (fileName === "clients.json") {
              clientsData = JSON.parse(strFromU8(data as Uint8Array));
            } else if (fileName === "projects.json") {
              projectsData = JSON.parse(strFromU8(data as Uint8Array));
            }
          }

          workspaceData = { clients: clientsData, projects: projectsData };
        } catch (err) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to parse zip file"
          );
          return;
        }
      } else if (file.name.endsWith(".csv")) {
        // Read CSV file for time entries
        const text = await file.text();
        entriesCsvs.push(text);
      }
    }

    // Merge multiple CSVs (skip header from subsequent files)
    let mergedCsv: string | null = null;
    let entryCount = 0;
    if (entriesCsvs.length > 0) {
      const allRows: string[] = [];
      entriesCsvs.forEach((csv, i) => {
        const lines = csv.split("\n").filter(line => line.trim());
        if (i === 0) {
          allRows.push(...lines);
        } else {
          allRows.push(...lines.slice(1));
        }
      });
      mergedCsv = allRows.join("\n");
      // Count entries (total rows minus header)
      entryCount = allRows.length > 0 ? allRows.length - 1 : 0;
    }

    setUploadedFiles({
      workspaceZip: workspaceData ? JSON.stringify(workspaceData) : null,
      entriesCsvs: mergedCsv ? [mergedCsv] : [],
      fileNames,
      entryCount,
    });
    setParsedWorkspace(workspaceData);
  };

  const startTogglImport = async () => {
    const { workspaceZip, entriesCsvs } = uploadedFiles;

    if (!workspaceZip && entriesCsvs.length === 0) return;

    setIsLoading(true);
    setError(null);

    try {
      // Determine source based on what was uploaded
      const hasWorkspace = !!workspaceZip;
      const hasEntries = entriesCsvs.length > 0;

      // Build the combined raw data
      const rawData = JSON.stringify({
        workspace: workspaceZip ? JSON.parse(workspaceZip) : null,
        entries: hasEntries ? entriesCsvs[0] : null,
      });

      const response = await fetch(`/api/v1/organizations/${orgId}/imports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: "toggl_combined",
          rawData,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to start import");
      }

      setSession(data.session);

      const clientsResponse = await fetch(
        `/api/v1/organizations/${orgId}/imports/${data.session.id}`
      );
      const clientsData = await clientsResponse.json();
      setExistingClients(clientsData.existingClients || []);

      const mappings = data.session.clientMappings || [];
      const firstUnconfirmed = mappings.findIndex(
        (m: ClientMapping) => !m.confirmed
      );
      setCurrentClientIndex(firstUnconfirmed >= 0 ? firstUnconfirmed : 0);
      setWizardStep("mapping");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start import");
    } finally {
      setIsLoading(false);
    }
  };

  const updateClientMapping = async (
    index: number,
    targetId: string | null,
    targetName: string
  ) => {
    if (!session) return;

    const mappings = [...(session.clientMappings || [])];
    mappings[index] = {
      ...mappings[index],
      targetId,
      targetName,
      confirmed: true,
    };

    setIsLoading(true);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/imports/${session.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientMappings: mappings }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update mapping");
      }

      setSession(data.session);

      const nextUnconfirmed = mappings.findIndex(
        (m, i) => i > index && !m.confirmed
      );
      if (nextUnconfirmed >= 0) {
        setCurrentClientIndex(nextUnconfirmed);
      } else {
        setCurrentClientIndex(mappings.length);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update mapping");
    } finally {
      setIsLoading(false);
    }
  };

  const confirmAllHighConfidence = async () => {
    if (!session) return;

    const mappings = (session.clientMappings || []).map((m) => ({
      ...m,
      confirmed: m.confidence >= 0.8 ? true : m.confirmed,
    }));

    setIsLoading(true);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/imports/${session.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientMappings: mappings }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to confirm mappings");
      }

      setSession(data.session);

      const firstUnconfirmed = mappings.findIndex((m) => !m.confirmed);
      setCurrentClientIndex(
        firstUnconfirmed >= 0 ? firstUnconfirmed : mappings.length
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to confirm mappings"
      );
    } finally {
      setIsLoading(false);
    }
  };

  const executeImport = async () => {
    if (!session) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/imports/${session.id}`,
        { method: "POST" }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Import failed");
      }

      setSession({
        ...session,
        status: "completed",
        currentStep: "complete",
        result: data.result,
      });
      setWizardStep("complete");
      setPendingImport(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setIsLoading(false);
    }
  };

  const cancelImport = async () => {
    if (session) {
      try {
        await fetch(`/api/v1/organizations/${orgId}/imports/${session.id}`, {
          method: "DELETE",
        });
      } catch {
        // Ignore
      }
    }
    setPendingImport(null);
    reset();
    setIsOpen(false);
    checkPendingImports();
  };

  const getConfidenceIcon = (confidence: number, confirmed: boolean) => {
    if (confirmed) {
      return <CheckCircle2 className="size-4 text-emerald-500" />;
    }
    if (confidence >= 0.8) {
      return <CheckCircle2 className="size-4 text-blue-500" />;
    }
    if (confidence >= 0.5) {
      return <HelpCircle className="size-4 text-amber-500" />;
    }
    return <AlertCircle className="size-4 text-red-500" />;
  };

  const clientMappings = session?.clientMappings || [];
  const confirmedCount = clientMappings.filter((m) => m.confirmed).length;
  const highConfidenceCount = clientMappings.filter(
    (m) => m.confidence >= 0.8
  ).length;

  // Render the trigger button
  const renderTrigger = () => {
    if (checkingPending) {
      return (
        <Button disabled className="squircle">
          <Loader2 className="size-4 animate-spin" />
          Checking...
        </Button>
      );
    }

    if (pendingImport) {
      return (
        <div className="flex items-center gap-3">
          <Button onClick={resumeImport} className="squircle">
            <RotateCcw className="size-4" />
            Continue Import
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              fetch(`/api/v1/organizations/${orgId}/imports/${pendingImport.id}`, {
                method: "DELETE",
              }).then(() => {
                setPendingImport(null);
              });
            }}
          >
            <X className="size-4" />
            Cancel
          </Button>
        </div>
      );
    }

    return (
      <Button onClick={openWizard} className="squircle">
        <Wand2 className="size-4" />
        Run Import Wizard
      </Button>
    );
  };

  return (
    <>
      {renderTrigger()}

      <Dialog open={isOpen} onOpenChange={(open) => !open && closeWizard()}>
        <DialogContent className="squircle max-w-lg">
          {error && (
            <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {/* Step: Intro */}
          {wizardStep === "intro" && (
            <>
              <DialogHeader>
                <DialogTitle>Import Wizard</DialogTitle>
                <DialogDescription>
                  Import your time tracking data from another service.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <p className="text-sm text-muted-foreground">
                  Import your clients and projects from Toggl:
                </p>
                <ul className="text-sm text-muted-foreground space-y-2">
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span>Upload your Toggl data export or connect via API</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span>Review and map clients (we&apos;ll auto-match when possible)</span>
                  </li>
                  <li className="flex items-start gap-2">
                    <CheckCircle2 className="size-4 text-emerald-500 mt-0.5 shrink-0" />
                    <span>Import clients and projects with rates, colors, and metadata</span>
                  </li>
                </ul>
                <p className="text-sm text-muted-foreground">
                  You can pause and resume at any time.
                </p>
              </div>

              <div className="flex justify-end">
                <Button onClick={() => setWizardStep("source")} className="squircle">
                  <ArrowRight className="size-4" />
                  Get Started
                </Button>
              </div>
            </>
          )}

          {/* Step: Source Selection */}
          {wizardStep === "source" && (
            <>
              <DialogHeader>
                <DialogTitle>Choose Import Source</DialogTitle>
                <DialogDescription>
                  Where would you like to import from?
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-3 py-4">
                <button
                  onClick={() => {
                    setSource("toggl_workspace");
                    setWizardStep("workspace_upload");
                  }}
                  className="flex items-start gap-3 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-left w-full"
                >
                  <FileArchive className="size-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="font-medium">Toggl Export Files <span className="text-xs text-emerald-600 ml-1">(Recommended)</span></p>
                    <p className="text-sm text-muted-foreground">
                      Upload your data export (zip) and time entries (CSV) all at once.
                    </p>
                  </div>
                </button>
                <button
                  onClick={() => {
                    setSource("toggl_api");
                    setWizardStep("toggl_connect");
                  }}
                  className="flex items-start gap-3 p-4 rounded-lg border hover:bg-muted/50 transition-colors text-left w-full"
                >
                  <Key className="size-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="font-medium">Toggl API</p>
                    <p className="text-sm text-muted-foreground">
                      Connect with your API token. Structure only, no time entries.
                    </p>
                  </div>
                </button>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setWizardStep("intro")} className="squircle">
                  Back
                </Button>
              </div>
            </>
          )}

          {/* Step: Toggl Connect */}
          {wizardStep === "toggl_connect" && (
            <>
              <DialogHeader>
                <DialogTitle>Connect to Toggl</DialogTitle>
                <DialogDescription>
                  Enter your Toggl API token to get started.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>API Token</Label>
                  <Input
                    type="password"
                    value={togglToken}
                    onChange={(e) => setTogglToken(e.target.value)}
                    placeholder="Enter your Toggl API token"
                    className="squircle"
                  />
                  <p className="text-xs text-muted-foreground">
                    Find your token at{" "}
                    <a
                      href="https://track.toggl.com/profile"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      Toggl Profile → API Token
                    </a>
                  </p>
                </div>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setWizardStep("source")} className="squircle">
                  Back
                </Button>
                <Button
                  onClick={connectToggl}
                  disabled={isLoading || !togglToken}
                  className="squircle"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  Connect
                </Button>
              </div>
            </>
          )}

          {/* Step: Toggl API Workspace Selection */}
          {wizardStep === "toggl_workspace_select" && (
            <>
              <DialogHeader>
                <DialogTitle>Select Workspace & Date Range</DialogTitle>
                <DialogDescription>
                  Choose which workspace to import from.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Workspace</Label>
                  <Select
                    value={selectedWorkspace?.toString() || ""}
                    onValueChange={(v) => setSelectedWorkspace(Number(v))}
                  >
                    <SelectTrigger className="squircle">
                      <SelectValue placeholder="Select workspace" />
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

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label>From</Label>
                    <Input
                      type="date"
                      value={dateRange.from}
                      onChange={(e) =>
                        setDateRange({ ...dateRange, from: e.target.value })
                      }
                      className="squircle"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>To</Label>
                    <Input
                      type="date"
                      value={dateRange.to}
                      onChange={(e) =>
                        setDateRange({ ...dateRange, to: e.target.value })
                      }
                      className="squircle"
                    />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground">
                  Note: Toggl&apos;s API limits exports to the last 90 days.
                </p>
              </div>

              <div className="flex justify-between">
                <Button
                  variant="outline"
                  onClick={() => {
                    setWorkspaces([]);
                    setWizardStep("toggl_connect");
                  }}
                  className="squircle"
                >
                  Back
                </Button>
                <Button
                  onClick={fetchTogglData}
                  disabled={isLoading || !selectedWorkspace}
                  className="squircle"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  Fetch Data
                </Button>
              </div>
            </>
          )}

          {/* Step: Workspace Upload - accepts zip + CSV files */}
          {wizardStep === "workspace_upload" && (
            <>
              <DialogHeader>
                <DialogTitle>Upload Toggl Files</DialogTitle>
                <DialogDescription>
                  Select all your Toggl export files at once
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="rounded-lg border border-dashed p-4 space-y-3">
                  <p className="text-sm font-medium">
                    In Toggl, export your data:
                  </p>
                  <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                    <li>
                      <span className="font-medium">Data Export</span>
                      <p className="text-xs ml-5">Settings → Data Export → Select Projects &amp; Clients → Export to email</p>
                    </li>
                    <li>
                      <span className="font-medium">Time Entries</span> (export each year)
                      <p className="text-xs ml-5">Reports → Select year → Export CSV</p>
                    </li>
                  </ol>
                </div>

                <div className="space-y-2">
                  <Label>Select all files (zip + CSV)</Label>
                  <Input
                    type="file"
                    accept=".zip,.csv"
                    multiple
                    onChange={handleFilesSelect}
                    className="squircle"
                  />
                </div>

                {uploadedFiles.fileNames.length > 0 && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950 p-3 space-y-2">
                    <p className="text-sm font-medium text-emerald-900 dark:text-emerald-100">
                      {uploadedFiles.fileNames.length} file{uploadedFiles.fileNames.length > 1 ? "s" : ""} selected
                    </p>
                    <ul className="text-xs text-emerald-700 dark:text-emerald-300 space-y-1">
                      {uploadedFiles.fileNames.map((name, i) => (
                        <li key={i} className="flex items-center gap-2">
                          {name.endsWith(".zip") ? (
                            <FileArchive className="size-3" />
                          ) : (
                            <FileSpreadsheet className="size-3" />
                          )}
                          {name}
                        </li>
                      ))}
                    </ul>
                    {(parsedWorkspace || uploadedFiles.entryCount > 0) && (
                      <p className="text-xs text-emerald-600 dark:text-emerald-400 pt-1 border-t border-emerald-200 dark:border-emerald-800">
                        Found {parsedWorkspace ? `${parsedWorkspace.clients.length} clients, ${parsedWorkspace.projects.length} projects` : ""}
                        {parsedWorkspace && uploadedFiles.entryCount > 0 && ", "}
                        {uploadedFiles.entryCount > 0 && `${uploadedFiles.entryCount.toLocaleString()} time entries`}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => setWizardStep("source")} className="squircle">
                  Back
                </Button>
                <Button
                  onClick={startTogglImport}
                  disabled={isLoading || (!parsedWorkspace && uploadedFiles.entriesCsvs.length === 0)}
                  className="squircle"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  Continue
                </Button>
              </div>
            </>
          )}

          {/* Step: Client Mapping */}
          {wizardStep === "mapping" && session && (
            <>
              <DialogHeader>
                <DialogTitle>Map Clients</DialogTitle>
                <DialogDescription>
                  {confirmedCount} of {clientMappings.length} clients mapped
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <Progress
                  value={(confirmedCount / clientMappings.length) * 100}
                />

                {/* Quick action: approve all high-confidence */}
                {highConfidenceCount > confirmedCount && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={confirmAllHighConfidence}
                    disabled={isLoading}
                    className="squircle w-full"
                  >
                    <Check className="size-4" />
                    Approve {highConfidenceCount - confirmedCount} auto-matched
                  </Button>
                )}

                {/* Current client being reviewed */}
                {currentClientIndex < clientMappings.length && (
                  <div className="rounded-lg border p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      {getConfidenceIcon(
                        clientMappings[currentClientIndex].confidence,
                        clientMappings[currentClientIndex].confirmed
                      )}
                      <span className="font-medium">
                        &quot;{clientMappings[currentClientIndex].sourceName}&quot;
                      </span>
                    </div>

                    {clientMappings[currentClientIndex].confidence >= 0.8 ? (
                      <p className="text-sm text-muted-foreground">
                        Matches{" "}
                        <strong>
                          {clientMappings[currentClientIndex].targetName}
                        </strong>
                      </p>
                    ) : clientMappings[currentClientIndex].targetId ? (
                      <p className="text-sm text-muted-foreground">
                        Might be{" "}
                        <strong>
                          {clientMappings[currentClientIndex].targetName}
                        </strong>
                      </p>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No match found. Create new or select existing.
                      </p>
                    )}

                    <div className="space-y-2">
                      <Label>Map to:</Label>
                      <Select
                        value={
                          clientMappings[currentClientIndex].targetId ||
                          `new:${clientMappings[currentClientIndex].targetName}`
                        }
                        onValueChange={(v) => {
                          const mappings = [...clientMappings];
                          if (v.startsWith("new:")) {
                            mappings[currentClientIndex] = {
                              ...mappings[currentClientIndex],
                              targetId: null,
                              targetName: v.replace("new:", ""),
                            };
                          } else {
                            const client = existingClients.find(
                              (c) => c.id === v
                            );
                            mappings[currentClientIndex] = {
                              ...mappings[currentClientIndex],
                              targetId: v,
                              targetName: client?.name || "",
                            };
                          }
                          setSession({ ...session, clientMappings: mappings });
                        }}
                      >
                        <SelectTrigger className="squircle">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="squircle">
                          {existingClients.length > 0 && (
                            <>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                Existing Clients
                              </div>
                              {existingClients.map((client) => (
                                <SelectItem key={client.id} value={client.id}>
                                  {client.name}
                                </SelectItem>
                              ))}
                              <div className="border-t my-1" />
                            </>
                          )}
                          <SelectItem
                            value={`new:${clientMappings[currentClientIndex].targetName}`}
                          >
                            <span className="text-blue-600">
                              + Create &quot;
                              {clientMappings[currentClientIndex].targetName}
                              &quot;
                            </span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {!clientMappings[currentClientIndex].targetId && (
                      <div className="space-y-2">
                        <Label>Client Name:</Label>
                        <Input
                          value={clientMappings[currentClientIndex].targetName}
                          onChange={(e) => {
                            const mappings = [...clientMappings];
                            mappings[currentClientIndex] = {
                              ...mappings[currentClientIndex],
                              targetName: e.target.value,
                            };
                            setSession({ ...session, clientMappings: mappings });
                          }}
                          className="squircle"
                        />
                      </div>
                    )}

                    <div className="flex gap-2 pt-2">
                      <Button
                        onClick={() =>
                          updateClientMapping(
                            currentClientIndex,
                            clientMappings[currentClientIndex].targetId,
                            clientMappings[currentClientIndex].targetName
                          )
                        }
                        disabled={
                          isLoading ||
                          !clientMappings[currentClientIndex].targetName
                        }
                        className="squircle flex-1"
                      >
                        {isLoading ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Check className="size-4" />
                        )}
                        Confirm
                      </Button>
                    </div>
                  </div>
                )}

                {/* All confirmed - ready to import */}
                {confirmedCount === clientMappings.length && (
                  <div className="rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="size-5 text-emerald-600" />
                      <span className="font-medium text-emerald-900 dark:text-emerald-100">
                        All clients mapped
                      </span>
                    </div>
                    <p className="text-sm text-emerald-800 dark:text-emerald-200">
                      {session.totalRows && session.totalRows > 0
                        ? `Ready to import ${session.totalRows} entries.`
                        : `Ready to import ${session.projectMappings?.length || 0} projects.`}
                    </p>
                    <Button onClick={executeImport} className="squircle w-full">
                      {isLoading ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Upload className="size-4" />
                      )}
                      Start Import
                    </Button>
                  </div>
                )}
              </div>

              <div className="flex justify-between">
                <Button variant="ghost" size="sm" onClick={cancelImport}>
                  <X className="size-4" />
                  Cancel
                </Button>
              </div>
            </>
          )}

          {/* Step: Complete */}
          {wizardStep === "complete" && session?.result && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <CheckCircle2 className="size-5 text-emerald-500" />
                  Import Complete
                </DialogTitle>
              </DialogHeader>

              <div className="space-y-4 py-4">
                <div className="rounded-lg border p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Clients created</span>
                    <span className="font-medium">{session.result.clientsCreated}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Projects created</span>
                    <span className="font-medium">{session.result.projectsCreated}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Tasks created</span>
                    <span className="font-medium">{session.result.tasksCreated}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Entries imported</span>
                    <span className="font-medium">{session.result.entriesImported}</span>
                  </div>
                  {session.result.entriesSkipped > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Duplicates skipped</span>
                      <span className="font-medium text-amber-600">
                        {session.result.entriesSkipped}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex justify-end">
                <Button onClick={closeWizard} className="squircle">
                  Done
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

"use client";

import { useState, useCallback } from "react";
import {
  Check,
  Loader2,
  Upload,
  X,
  FileSpreadsheet,
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

type ExistingClient = {
  id: string;
  name: string;
};

type PreviewData = {
  entryCount: number;
  projects: string[];
  existingClients: ExistingClient[];
  dateRange: { from: string; to: string };
};

type ProjectMapping = {
  projectName: string;
  clientId: string;
  clientName: string;
};

type ImportResult = {
  clientsCreated: number;
  projectsCreated: number;
  tasksCreated: number;
  entriesImported: number;
  entriesSkipped: number;
  errors: string[];
};

type Step = "upload" | "preview" | "mapping" | "importing" | "complete";

// Track new clients being created during this import
type NewClient = {
  tempId: string; // "new:clientname"
  name: string;
};

type TogglCSVImportProps = {
  orgId: string;
};

export function TogglCSVImport({ orgId }: TogglCSVImportProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [csvData, setCsvData] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [projectMappings, setProjectMappings] = useState<ProjectMapping[]>([]);
  const [newClients, setNewClients] = useState<NewClient[]>([]); // Clients being created
  const [result, setResult] = useState<ImportResult | null>(null);

  const reset = useCallback(() => {
    setStep("upload");
    setCsvData(null);
    setFileName(null);
    setPreview(null);
    setProjectMappings([]);
    setNewClients([]);
    setResult(null);
    setError(null);
  }, []);

  // Add a new client to the list
  const addNewClient = useCallback((name: string) => {
    const tempId = `new:${name}`;
    setNewClients((prev) => {
      // Don't add duplicates
      if (prev.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
        return prev;
      }
      return [...prev, { tempId, name }];
    });
    return tempId;
  }, []);

  // Update a new client's name
  const updateNewClientName = useCallback((tempId: string, newName: string) => {
    const newTempId = `new:${newName}`;
    setNewClients((prev) =>
      prev.map((c) => (c.tempId === tempId ? { tempId: newTempId, name: newName } : c))
    );
    // Update any mappings using the old tempId
    setProjectMappings((prev) =>
      prev.map((m) =>
        m.clientId === tempId ? { ...m, clientId: newTempId, clientName: newName } : m
      )
    );
  }, []);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setError(null);

    const text = await file.text();
    setCsvData(text);
  };

  const handlePreview = async () => {
    if (!csvData) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/csv-import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csvData }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to parse CSV");
      }

      setPreview(data);

      // Initialize mappings - try to guess client from project name
      const guessedNewClients = new Map<string, string>(); // name -> tempId
      const mappings: ProjectMapping[] = data.projects.map((projectName: string) => {
        // Try to find matching existing client
        const words = projectName.split(" ");
        const firstWord = words[0];
        const matchingClient = data.existingClients.find(
          (c: ExistingClient) =>
            c.name.toLowerCase().includes(firstWord.toLowerCase()) ||
            firstWord.toLowerCase().includes(c.name.toLowerCase())
        );

        if (matchingClient) {
          return {
            projectName,
            clientId: matchingClient.id,
            clientName: matchingClient.name,
          };
        }

        // Create/reuse a new client entry
        if (!guessedNewClients.has(firstWord)) {
          guessedNewClients.set(firstWord, `new:${firstWord}`);
        }
        return {
          projectName,
          clientId: `new:${firstWord}`,
          clientName: firstWord,
        };
      });

      // Set up the new clients list from guesses
      const newClientsList: NewClient[] = Array.from(guessedNewClients.entries()).map(
        ([name, tempId]) => ({ tempId, name })
      );
      setNewClients(newClientsList);
      setProjectMappings(mappings);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to parse CSV");
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = async () => {
    if (!csvData || projectMappings.length === 0) return;

    setIsLoading(true);
    setError(null);
    setStep("importing");

    try {
      const response = await fetch(
        `/api/v1/organizations/${orgId}/integrations/toggl/csv-import`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ csvData, projectMappings }),
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

  const updateMapping = (projectName: string, clientId: string, clientName?: string) => {
    setProjectMappings((prev) =>
      prev.map((m) =>
        m.projectName === projectName
          ? { ...m, clientId, clientName: clientName || m.clientName }
          : m
      )
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
            <FileSpreadsheet className="size-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-lg">Import from CSV</CardTitle>
              <CardDescription>
                Import full history via Toggl&apos;s CSV export. No date limit.
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

          {/* Step: Upload */}
          {step === "upload" && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Toggl CSV Export</Label>
                <Input
                  type="file"
                  accept=".csv"
                  onChange={handleFileSelect}
                  className="squircle"
                />
                <p className="text-xs text-muted-foreground">
                  Export from Toggl: Reports → Detailed → Export → CSV
                </p>
              </div>

              {fileName && (
                <p className="text-sm text-muted-foreground">
                  Selected: {fileName}
                </p>
              )}

              <div className="flex justify-end">
                <Button
                  onClick={handlePreview}
                  disabled={isLoading || !csvData}
                  className="squircle"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Upload className="size-4" />
                  )}
                  Preview Import
                </Button>
              </div>
            </div>
          )}

          {/* Step: Preview & Mapping */}
          {(step === "preview" || step === "mapping") && preview && (
            <div className="space-y-4">
              {/* Summary */}
              <div className="rounded-lg border p-4 space-y-3">
                <h4 className="font-medium">Import Summary</h4>
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div>
                    <div className="text-2xl font-bold">{preview.entryCount}</div>
                    <div className="text-xs text-muted-foreground">Entries</div>
                  </div>
                  <div>
                    <div className="text-2xl font-bold">{preview.projects.length}</div>
                    <div className="text-xs text-muted-foreground">Projects</div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  Date range: {preview.dateRange.from} to {preview.dateRange.to}
                </p>
              </div>

              {/* New Clients Section */}
              {newClients.length > 0 && (
                <div className="space-y-2">
                  <h4 className="font-medium">New Clients to Create</h4>
                  <p className="text-sm text-muted-foreground">
                    Edit names for clients that will be created
                  </p>
                  <div className="space-y-2">
                    {newClients.map((client) => (
                      <div
                        key={client.tempId}
                        className="flex items-center gap-2"
                      >
                        <Input
                          value={client.name}
                          onChange={(e) => updateNewClientName(client.tempId, e.target.value)}
                          className="squircle"
                          placeholder="Client name"
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="shrink-0"
                          onClick={() => {
                            // Remove client and reset any mappings using it
                            setNewClients((prev) => prev.filter((c) => c.tempId !== client.tempId));
                            setProjectMappings((prev) =>
                              prev.map((m) =>
                                m.clientId === client.tempId
                                  ? { ...m, clientId: "", clientName: "" }
                                  : m
                              )
                            );
                          }}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Project → Client Mappings */}
              <div className="space-y-2">
                <h4 className="font-medium">Map Projects to Clients</h4>
                <p className="text-sm text-muted-foreground">
                  Assign each project to an existing or new client
                </p>
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {projectMappings.map((mapping) => (
                    <div
                      key={mapping.projectName}
                      className="flex items-center gap-3 p-2 rounded-lg border"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium truncate block">
                          {mapping.projectName}
                        </span>
                      </div>
                      <Select
                        value={mapping.clientId}
                        onValueChange={(v) => {
                          if (v === "__create_new__") {
                            // Create a new client with project's first word as default name
                            const defaultName = mapping.projectName.split(" ")[0];
                            let name = defaultName;
                            let counter = 1;
                            // Ensure unique name
                            while (newClients.some((c) => c.name === name)) {
                              name = `${defaultName} ${counter++}`;
                            }
                            const tempId = addNewClient(name);
                            updateMapping(mapping.projectName, tempId, name);
                          } else if (v.startsWith("new:")) {
                            const client = newClients.find((c) => c.tempId === v);
                            updateMapping(mapping.projectName, v, client?.name || "");
                          } else {
                            const client = preview.existingClients.find((c) => c.id === v);
                            updateMapping(mapping.projectName, v, client?.name);
                          }
                        }}
                      >
                        <SelectTrigger className="squircle w-[200px]">
                          <SelectValue placeholder="Select client">
                            {mapping.clientId ? (
                              mapping.clientId.startsWith("new:") ? (
                                <span className="text-blue-600">+ {mapping.clientName}</span>
                              ) : (
                                mapping.clientName
                              )
                            ) : (
                              "Select client"
                            )}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent className="squircle">
                          {preview.existingClients.length > 0 && (
                            <>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                Existing Clients
                              </div>
                              {preview.existingClients.map((client) => (
                                <SelectItem key={client.id} value={client.id}>
                                  {client.name}
                                </SelectItem>
                              ))}
                            </>
                          )}
                          {newClients.length > 0 && (
                            <>
                              <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
                                New Clients
                              </div>
                              {newClients.map((client) => (
                                <SelectItem key={client.tempId} value={client.tempId}>
                                  <span className="text-blue-600">+ {client.name}</span>
                                </SelectItem>
                              ))}
                            </>
                          )}
                          <div className="border-t my-1" />
                          <SelectItem value="__create_new__">
                            <span className="text-blue-600">+ Create new client...</span>
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex justify-between">
                <Button variant="outline" onClick={reset} className="squircle">
                  <X className="size-4" />
                  Cancel
                </Button>
                <Button
                  onClick={handleImport}
                  disabled={isLoading || projectMappings.some((m) => !m.clientId)}
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
              <p className="text-muted-foreground">Importing entries...</p>
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
                  <span className="text-muted-foreground">Clients created</span>
                  <span className="font-medium">{result.clientsCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Projects created</span>
                  <span className="font-medium">{result.projectsCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Tasks created</span>
                  <span className="font-medium">{result.tasksCreated}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">Entries imported</span>
                  <span className="font-medium">{result.entriesImported}</span>
                </div>
                {result.entriesSkipped > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      Duplicates skipped
                    </span>
                    <span className="font-medium text-amber-600">
                      {result.entriesSkipped}
                    </span>
                  </div>
                )}
              </div>

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

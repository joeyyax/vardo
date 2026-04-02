"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Loader2,
  Rocket,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Activity,
  Server,
  FileText,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

type InstallStage =
  | "template_render"
  | "app_create"
  | "env_setup"
  | "deploy_start"
  | "deploy_progress"
  | "health_check"
  | "complete"
  | "failed"
  | "rollback";

interface InstallState {
  stage: InstallStage;
  message: string;
  progress: number;
  appId?: string;
  deploymentId?: string;
  error?: string;
  canRetry?: boolean;
}

interface InstallIntegrationModalProps {
  type: string;
  label: string;
  description: string;
  defaultAppName: string;
  supportsGpu?: boolean;
  onInstalled?: (integration: { id: string; type: string; status: string; appId: string }) => void;
}

const STAGE_ICONS: Record<InstallStage, typeof Activity> = {
  template_render: FileText,
  app_create: Server,
  env_setup: Server,
  deploy_start: Rocket,
  deploy_progress: Loader2,
  health_check: Activity,
  complete: CheckCircle2,
  failed: XCircle,
  rollback: AlertCircle,
};

const STAGE_LABELS: Record<InstallStage, string> = {
  template_render: "Loading template",
  app_create: "Creating app",
  env_setup: "Setting up environment",
  deploy_start: "Starting deployment",
  deploy_progress: "Deploying",
  health_check: "Health check",
  complete: "Complete",
  failed: "Failed",
  rollback: "Rolling back",
};

export function InstallIntegrationModal({
  type,
  label,
  description,
  defaultAppName,
  supportsGpu = false,
  onInstalled,
}: InstallIntegrationModalProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"config" | "installing" | "complete" | "error">("config");
  const [name, setName] = useState(defaultAppName);
  const [gpu, setGpu] = useState(false);
  const [installState, setInstallState] = useState<InstallState>({
    stage: "template_render",
    message: "Loading template...",
    progress: 0,
  });
  const [logs, setLogs] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-scroll logs
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  // Cleanup on unmount - abort any active SSE connection
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  const handleClose = useCallback(() => {
    // Don't allow closing during active install unless complete/failed
    if (step === "installing") {
      // Cancel the request
      abortControllerRef.current?.abort();
    }
    setOpen(false);
    // Reset state after animation
    setTimeout(() => {
      setStep("config");
      setName(defaultAppName);
      setGpu(false);
      setInstallState({
        stage: "template_render",
        message: "Loading template...",
        progress: 0,
      });
      setLogs([]);
    }, 300);
  }, [step, defaultAppName]);

  const handleInstall = useCallback(async () => {
    setStep("installing");
    setLogs([]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch("/api/v1/admin/integrations/install/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, name: name || defaultAppName, gpu }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to start installation");
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.startsWith("event: ")) {
            const eventName = line.slice(7);
            const dataLine = lines[++i];
            if (dataLine?.startsWith("data: ")) {
              const data = JSON.parse(dataLine.slice(6));

              if (eventName === "stage") {
                setInstallState((prev) => ({
                  ...prev,
                  stage: data.stage,
                  message: data.message,
                  progress: data.progress ?? prev.progress,
                  appId: data.appId ?? prev.appId,
                  deploymentId: data.deploymentId ?? prev.deploymentId,
                  error: data.error,
                  canRetry: data.canRetry,
                }));

                if (data.stage === "complete") {
                  setStep("complete");
                  onInstalled?.({
                    id: data.appId,
                    type,
                    status: "connected",
                    appId: data.appId,
                  });
                } else if (data.stage === "failed") {
                  setStep("error");
                }
              } else if (eventName === "log") {
                setLogs((prev) => [...prev, data.message]);
              }
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // User cancelled
        return;
      }
      setStep("error");
      setInstallState((prev) => ({
        ...prev,
        stage: "failed",
        message: err instanceof Error ? err.message : "Installation failed",
        error: err instanceof Error ? err.message : "Unknown error",
        canRetry: true,
      }));
    }
  }, [type, name, defaultAppName, gpu, onInstalled, installState.progress]);

  const handleRetry = useCallback(() => {
    setStep("config");
    setInstallState({
      stage: "template_render",
      message: "Loading template...",
      progress: 0,
    });
    setLogs([]);
  }, []);

  const CurrentIcon = STAGE_ICONS[installState.stage];
  const isProcessing = step === "installing";
  const isComplete = step === "complete";
  const isError = step === "error";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="squircle">
          <Rocket className="size-3.5 mr-1.5" />
          Install
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isComplete ? (
              <CheckCircle2 className="size-5 text-green-500" />
            ) : isError ? (
              <XCircle className="size-5 text-red-500" />
            ) : (
              <Rocket className="size-5" />
            )}
            {isComplete ? `${label} Installed` : isError ? "Installation Failed" : `Install ${label}`}
          </DialogTitle>
          <DialogDescription>
            {isComplete
              ? "Your integration is ready to use."
              : isError
                ? installState.message
                : description}
          </DialogDescription>
        </DialogHeader>

        {step === "config" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="integration-name">App name</Label>
              <Input
                id="integration-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={defaultAppName}
                className="squircle"
              />
              <p className="text-xs text-muted-foreground">
                This will be the name of the app created for this integration.
              </p>
            </div>

            {supportsGpu && (
              <div className="flex items-center justify-between rounded-lg border p-3">
                <div className="space-y-0.5">
                  <Label htmlFor="gpu-toggle" className="text-sm">Enable GPU support</Label>
                  <p className="text-xs text-muted-foreground">
                    Enable if your host has NVIDIA GPUs
                  </p>
                </div>
                <Switch
                  id="gpu-toggle"
                  checked={gpu}
                  onCheckedChange={setGpu}
                />
              </div>
            )}

            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <div className="flex items-start gap-2">
                <Info className="size-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium text-foreground mb-1">What happens next?</p>
                  <ul className="space-y-1 list-disc list-inside">
                    <li>Creates a new app from the {label.toLowerCase()} template</li>
                    <li>Configures environment and persistent volumes</li>
                    <li>Deploys and waits for health checks</li>
                    <li>Connects the integration to your Vardo instance</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        )}

        {(isProcessing || isComplete || isError) && (
          <div className="space-y-4">
            {/* Progress section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <CurrentIcon
                    className={cn(
                      "size-4",
                      isProcessing && installState.stage === "deploy_progress" && "animate-spin"
                    )}
                  />
                  <span className={cn(
                    isComplete && "text-green-600",
                    isError && "text-red-600"
                  )}>
                    {STAGE_LABELS[installState.stage]}
                  </span>
                </div>
                <span className="text-muted-foreground">{installState.progress}%</span>
              </div>
              <Progress value={installState.progress} className="h-2" />
            </div>

            {/* Live activity indicator - iOS style */}
            {isProcessing && (
              <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-3">
                <div className="relative">
                  <div className="size-8 rounded-full bg-primary/10 flex items-center justify-center">
                    <Activity className="size-4 text-primary animate-pulse" />
                  </div>
                  <div className="absolute inset-0 size-8 rounded-full bg-primary/20 animate-ping" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{installState.message}</p>
                  <p className="text-xs text-muted-foreground">This may take a few minutes...</p>
                </div>
              </div>
            )}

            {/* Deploy logs */}
            {logs.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Deploy logs</Label>
                <div className="h-32 overflow-auto rounded-md bg-black text-green-400 font-mono text-xs p-3">
                  {logs.map((log, i) => (
                    <div key={i} className="py-0.5">{log}</div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            )}

            {/* Error details */}
            {isError && installState.error && (
              <div className="rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 dark:border-red-900 p-3">
                <p className="text-sm text-red-800 dark:text-red-200">
                  {installState.error}
                </p>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {step === "config" ? (
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleInstall} disabled={!name}>
                <Rocket className="size-4 mr-1.5" />
                Start Installation
              </Button>
            </>
          ) : isComplete ? (
            <Button onClick={handleClose}>
              <CheckCircle2 className="size-4 mr-1.5" />
              Done
            </Button>
          ) : isError ? (
            <>
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              {installState.canRetry && (
                <Button onClick={handleRetry}>
                  <Rocket className="size-4 mr-1.5" />
                  Try Again
                </Button>
              )}
            </>
          ) : (
            <Button variant="outline" onClick={handleClose}>
              <Loader2 className="size-4 mr-1.5 animate-spin" />
              Installing...
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

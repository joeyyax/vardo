"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { formatDuration } from "@/components/app-status";

import type { Deployment, RollbackPreview } from "../types";

type StageStatus = "running" | "success" | "failed" | "skipped";

/** Wall-clock window per phase, filled in as stage events arrive. */
export type StageTiming = { startedAt: number; endedAt?: number };

/** Toast text for a deploy that ended without succeeding and without an error. */
const TERMINAL_MESSAGES: Record<string, string> = {
  cancelled: "Deployment cancelled",
  superseded: "Superseded by a newer deploy",
  rolled_back: "Deployment rolled back",
};

/** Cancels and supersedes are outcomes, not faults — they don't warrant an error toast. */
export const NOT_A_FAULT = new Set(["cancelled", "superseded"]);

export function terminalMessage(status?: string, error?: string): string {
  return error || (status ? TERMINAL_MESSAGES[status] : undefined) || "Deployment failed";
}

/** A deploy that landed. Warns instead of celebrating when its tail did not finish. */
function toastDeployed(durationMs?: number | null, postDeployError?: string | null) {
  const text = durationMs ? `Deployed in ${formatDuration(durationMs)}` : "Deployed";
  if (!postDeployError) {
    toast.success(text);
    return;
  }
  toast.warning(text, {
    description: `Post-deploy work unfinished: ${postDeployError.split("\n").join(" · ")}`,
  });
}

export function useDeploy({
  orgId,
  appId,
  selectedEnvId,
  serverRunningDeploy,
  onDeployStarted,
}: {
  orgId: string;
  appId: string;
  selectedEnvId: string | undefined;
  serverRunningDeploy: Deployment | null | undefined;
  onDeployStarted?: () => void;
}) {
  // Keep stable refs for callbacks to avoid re-triggering effects
  const onDeployStartedRef = useRef(onDeployStarted);
  onDeployStartedRef.current = onDeployStarted;
  const router = useRouter();
  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployStartTime, setDeployStartTime] = useState<number | null>(null);
  const [deployStages, setDeployStages] = useState<Record<string, StageStatus>>({});
  const [deployStageTimes, setDeployStageTimes] = useState<Record<string, StageTiming>>({});
  const recordStage = useCallback((stage: string, status: StageStatus) => {
    const at = Date.now();
    setDeployStages((prev) => ({ ...prev, [stage]: status }));
    setDeployStageTimes((prev) => {
      const entry = prev[stage] ?? { startedAt: at };
      return {
        ...prev,
        [stage]: status === "running" ? { startedAt: at } : { ...entry, endedAt: at },
      };
    });
  }, []);
  const [expandedDeployLog, setExpandedDeployLog] = useState(false);
  const [deployAbort, setDeployAbort] = useState<AbortController | null>(null);
  const [deployAnnouncement, setDeployAnnouncement] = useState("");
  const announce = useCallback((message: string) => {
    setDeployAnnouncement(message);
  }, []);
  const [viewingLogId, setViewingLogId] = useState<string | null>(null);

  // Rollback state
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [rollbackPreview, setRollbackPreview] = useState<RollbackPreview | null>(null);
  const [rollbackIncludeEnv, setRollbackIncludeEnv] = useState(false);
  const [rollbackLoading, setRollbackLoading] = useState(false);

  // If a deploy is already running (e.g. auto-deploy on creation),
  // show the in-progress UI and poll for updates until it finishes
  useEffect(() => {
    if (!serverRunningDeploy || deploying) return;
    setDeploying(true);
    setDeployStartTime(new Date(serverRunningDeploy.startedAt).getTime());
    onDeployStartedRef.current?.();
    setExpandedDeployLog(true);

    // Connect to the deploy stream SSE endpoint for real-time logs
    const streamUrl = `/api/v1/organizations/${orgId}/apps/${appId}/deploy/stream`;
    const es = new EventSource(streamUrl);
    let finished = false;

    es.addEventListener("log", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.message) {
          setDeployLog((prev) => [...prev, data.message]);
        }
      } catch { /* skip malformed */ }
    });

    es.addEventListener("stage", (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.stage && data.status) {
          recordStage(data.stage, data.status);
        }
      } catch { /* skip malformed */ }
    });

    es.addEventListener("done", (event) => {
      try {
        const data = JSON.parse(event.data);
        finished = true;
        if (data.success) {
          toastDeployed(data.durationMs, data.postDeployError);
          announce("Deployment succeeded.");
        } else {
          const message = terminalMessage(data.status, data.error);
          if (NOT_A_FAULT.has(data.status)) toast.info(message);
          else toast.error(message);
          announce(`${message}.`);
        }
        if (data.deploymentId) {
          setViewingLogId(data.deploymentId);
        }
      } catch { /* skip malformed */ }
      es.close();
      setDeploying(false);
      setDeployAbort(null);
      router.refresh();
    });

    es.addEventListener("timeout", () => {
      es.close();
      if (!finished) {
        setDeploying(false);
        setDeployAbort(null);
        router.refresh();
      }
    });

    es.onerror = () => {
      // SSE connection failed -- fall back to polling
      es.close();
      if (finished) return;
      let stopped = false;
      async function poll() {
        while (!stopped) {
          await new Promise((r) => setTimeout(r, 3000));
          if (stopped) break;
          try {
            const res = await fetch(
              `/api/v1/organizations/${orgId}/apps/${appId}`,
            );
            if (!res.ok) continue;
            const { app: updated } = await res.json();
            const dep = updated.deployments?.find((d: { id: string }) => d.id === serverRunningDeploy!.id);
            if (dep?.log) {
              setDeployLog(dep.log.split("\n"));
            }
            if (dep?.status && dep.status !== "running" && dep.status !== "queued") {
              if (dep.status === "success") {
                toastDeployed(dep.durationMs, dep.postDeployError);
              } else if (dep.status !== "failed") {
                const message = terminalMessage(dep.status);
                if (NOT_A_FAULT.has(dep.status)) toast.info(message);
                else toast.error(message);
              } else {
                // Extract last error line from deploy log for the toast
                const errorLine = dep.log
                  ?.split("\n")
                  .reverse()
                  .find((l: string) => l.includes("ERROR") || l.includes("FATAL") || l.includes("failed"));
                const cleaned = errorLine
                  ?.replace(/^\[.*?\]\s*/, "")
                  .replace(/x-access-token:[^\s@]+/g, "***")
                  .replace(/ghs_[A-Za-z0-9]+/g, "***")
                  .trim();
                toast.error(cleaned || "Deployment failed");
              }
              setViewingLogId(dep.id);
              stopped = true;
            }
          } catch { /* retry */ }
        }
        setDeploying(false);
        setDeployAbort(null);
        router.refresh();
      }
      poll();
    };

    return () => { es.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverRunningDeploy?.id]);

  const handleDeploy = useCallback(async () => {
    announce("");
    setDeploying(true);
    onDeployStartedRef.current?.();
    setDeployLog([]);
    setDeployStages({});
    setDeployStageTimes({});
    setExpandedDeployLog(false);
    setDeployStartTime(Date.now());

    const abort = new AbortController();
    setDeployAbort(abort);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/deploy`,
        {
          method: "POST",
          signal: abort.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ environmentId: selectedEnvId }),
        }
      );

      if (!res.body) {
        toast.error("Deployment failed — no response");
        setDeploying(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "log") {
              setDeployLog((prev) => [...prev, data as string]);
            } else if (eventType === "stage") {
              const { stage, status } = data as { stage: string; status: StageStatus };
              recordStage(stage, status);
            } else if (eventType === "done") {
              const result = data as { deploymentId: string; success: boolean; durationMs: number; status?: string; error?: string; postDeployError?: string };
              if (result.success) {
                toastDeployed(result.durationMs, result.postDeployError);
                announce("Deployment succeeded.");
              } else {
                const message = terminalMessage(result.status, result.error);
                if (NOT_A_FAULT.has(result.status ?? "")) toast.info(message);
                else toast.error(message);
                setDeployAnnouncement(`${message}.`);
              }
              if (result.deploymentId) {
                setViewingLogId(result.deploymentId);
              }
            } else if (eventType === "error") {
              toast.error((data as { message: string }).message);
            }
          }
        }
      }

      router.refresh();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        toast.info("Deployment aborted");
      } else {
        toast.error(err instanceof Error ? err.message : "Deployment failed");
      }
    } finally {
      setDeploying(false);
      setDeployAbort(null);
    }
  }, [orgId, appId, selectedEnvId, setDeploying, announce, router, recordStage]);

  async function handleRollbackPreview(deploymentId: string) {
    setRollbackTarget(deploymentId);
    setRollbackPreview(null);
    setRollbackIncludeEnv(false);
    setRollbackLoading(true);
    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/rollback?deploymentId=${deploymentId}`,
      );
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || "Failed to load rollback preview");
        setRollbackTarget(null);
        return;
      }
      const preview = await res.json();
      setRollbackPreview(preview);
    } catch {
      toast.error("Failed to load rollback preview");
      setRollbackTarget(null);
    } finally {
      setRollbackLoading(false);
    }
  }

  async function handleRollbackConfirm() {
    if (!rollbackTarget) return;
    const targetId = rollbackTarget;
    const includeEnv = rollbackIncludeEnv;
    setRollbackTarget(null);
    setRollbackPreview(null);

    // Reuse the same SSE deploy flow
    setDeploying(true);
    onDeployStartedRef.current?.();
    setDeployLog([]);
    setDeployStages({});
    setDeployStageTimes({});
    setExpandedDeployLog(false);
    setDeployStartTime(Date.now());

    const abort = new AbortController();
    setDeployAbort(abort);

    try {
      const res = await fetch(
        `/api/v1/organizations/${orgId}/apps/${appId}/rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deploymentId: targetId,
            includeEnvVars: includeEnv,
          }),
          signal: abort.signal,
        },
      );

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        toast.error((data as { error?: string }).error || "Rollback failed");
        setDeploying(false);
        setDeployAbort(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (eventType === "log") {
              setDeployLog((prev) => [...prev, data as string]);
            } else if (eventType === "stage") {
              const { stage, status } = data as { stage: string; status: StageStatus };
              recordStage(stage, status);
            } else if (eventType === "done") {
              const result = data as { deploymentId: string; success: boolean; durationMs: number; status?: string; error?: string };
              if (result.success) {
                toast.success("Rollback deployed successfully");
              } else if (NOT_A_FAULT.has(result.status ?? "")) {
                toast.info(terminalMessage(result.status, result.error));
              } else {
                toast.error(result.error || "Rollback deployment failed");
              }
              if (result.deploymentId) {
                setViewingLogId(result.deploymentId);
              }
            }
          }
        }
      }

      router.refresh();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        toast.info("Rollback aborted");
      } else {
        toast.error("Rollback failed");
      }
    } finally {
      setDeploying(false);
      setDeployAbort(null);
    }
  }

  return {
    deploying,
    deployLog,
    deployStartTime,
    deployStages,
    deployStageTimes,
    expandedDeployLog,
    setExpandedDeployLog,
    deployAbort,
    deployAnnouncement,
    viewingLogId,
    setViewingLogId,
    handleDeploy,
    rollbackTarget,
    setRollbackTarget,
    rollbackPreview,
    setRollbackPreview,
    rollbackIncludeEnv,
    setRollbackIncludeEnv,
    rollbackLoading,
    handleRollbackPreview,
    handleRollbackConfirm,
  };
}

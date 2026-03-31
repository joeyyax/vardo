"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/messenger";
import { formatDuration } from "@/components/app-status";

import type { Deployment, RollbackPreview } from "../types";

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
  const [deployStages, setDeployStages] = useState<
    Record<string, "running" | "success" | "failed" | "skipped">
  >({});
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
          setDeployStages((prev) => ({ ...prev, [data.stage]: data.status }));
        }
      } catch { /* skip malformed */ }
    });

    es.addEventListener("done", (event) => {
      try {
        const data = JSON.parse(event.data);
        finished = true;
        if (data.success) {
          toast.success(data.durationMs ? `Deployed in ${formatDuration(data.durationMs)}` : "Deployed");
          announce("Deployment succeeded.");
        } else if (data.status === "rolled_back") {
          toast.error("Deployment rolled back");
          announce("Deployment rolled back.");
        } else {
          toast.error(data.error || "Deployment failed");
          announce(`Deployment failed. ${data.error || ""}`);
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

    es.addEventListener("rolled_back", (event) => {
      try {
        const data = JSON.parse(event.data);
        finished = true;
        toast.error(data.message || "Deployment rolled back");
        announce(data.message || "Deployment rolled back.");
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
            if (dep?.status === "success" || dep?.status === "failed" || dep?.status === "rolled_back") {
              if (dep.status === "success") {
                toast.success(dep.durationMs ? `Deployed in ${formatDuration(dep.durationMs)}` : "Deployed");
              } else if (dep.status === "rolled_back") {
                toast.error("Deployment rolled back");
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
    setExpandedDeployLog(false);
    setDeployStartTime(Date.now());

    // Queue stage updates with minimum display time
    const stageQueue: { stage: string; status: string }[] = [];
    let processingStages = false;
    const MIN_STAGE_MS = 600;

    async function processStageQueue() {
      if (processingStages) return;
      processingStages = true;
      while (stageQueue.length > 0) {
        const { stage, status } = stageQueue.shift()!;
        setDeployStages((prev) => ({ ...prev, [stage]: status as "running" | "success" | "failed" | "skipped" }));
        if (status === "running") {
          await new Promise((r) => setTimeout(r, MIN_STAGE_MS));
        }
      }
      processingStages = false;
    }

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
              const { stage, status } = data as { stage: string; status: string };
              stageQueue.push({ stage, status });
              processStageQueue();
            } else if (eventType === "done") {
              const result = data as { deploymentId: string; success: boolean; durationMs: number; error?: string };
              if (result.success) {
                toast.success(`Deployed in ${formatDuration(result.durationMs)}`);
                announce("Deployment succeeded.");
              } else {
                toast.error(result.error || "Deployment failed");
                setDeployAnnouncement(`Deployment failed. ${result.error || ""}`);
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
  }, [orgId, appId, selectedEnvId, setDeploying, announce, router]);

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
    setExpandedDeployLog(false);
    setDeployStartTime(Date.now());

    const stageQueue: { stage: string; status: string }[] = [];
    let processingStages = false;
    const MIN_STAGE_MS = 600;

    async function processStageQueue() {
      if (processingStages) return;
      processingStages = true;
      while (stageQueue.length > 0) {
        const next = stageQueue.shift()!;
        setDeployStages((prev) => ({ ...prev, [next.stage]: next.status as "running" | "success" | "failed" | "skipped" }));
        await new Promise((r) => setTimeout(r, MIN_STAGE_MS));
      }
      processingStages = false;
    }

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
              const { stage, status } = data as { stage: string; status: string };
              stageQueue.push({ stage, status });
              processStageQueue();
            } else if (eventType === "done") {
              const result = data as { deploymentId: string; success: boolean; durationMs: number };
              if (result.success) {
                toast.success("Rollback deployed successfully");
              } else {
                toast.error("Rollback deployment failed");
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

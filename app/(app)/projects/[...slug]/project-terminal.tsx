"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Container = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
};

type ProjectTerminalProps = {
  projectId: string;
  orgId: string;
};

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export function ProjectTerminal({ projectId, orgId }: ProjectTerminalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [containers, setContainers] = useState<Container[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);
  const [loadingContainers, setLoadingContainers] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const baseUrl = `/api/v1/organizations/${orgId}/projects/${projectId}`;

  // Fetch available containers
  const fetchContainers = useCallback(async () => {
    setLoadingContainers(true);
    try {
      const res = await fetch(`${baseUrl}/containers`);
      if (!res.ok) {
        setContainers([]);
        setErrorMessage("Failed to fetch containers");
        return;
      }
      const data = await res.json();
      const list = data.containers as Container[];
      setContainers(list);
      setErrorMessage(null);

      // Auto-select first container if none selected
      if (list.length > 0 && !selectedContainer) {
        setSelectedContainer(list[0].id);
      }
    } catch {
      setContainers([]);
      setErrorMessage("Failed to fetch containers");
    } finally {
      setLoadingContainers(false);
    }
  }, [baseUrl, selectedContainer]);

  useEffect(() => {
    fetchContainers();
  }, [fetchContainers]);

  // Send input to the terminal session
  const sendInput = useCallback(
    async (data: string) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      try {
        await fetch(`${baseUrl}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            type: "input",
            data: btoa(data),
          }),
        });
      } catch {
        // Input send failed — connection may be dead
      }
    },
    [baseUrl],
  );

  // Send resize to the terminal session
  const sendResize = useCallback(
    async (cols: number, rows: number) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) return;

      try {
        await fetch(`${baseUrl}/terminal`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            type: "resize",
            cols,
            rows,
          }),
        });
      } catch {
        // Resize failed — non-fatal
      }
    },
    [baseUrl],
  );

  // Connect to terminal
  const connect = useCallback(
    (containerId: string) => {
      // Clean up any existing connection
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      sessionIdRef.current = null;

      // Initialize xterm if not already
      if (!xtermRef.current && terminalRef.current) {
        const term = new XTerm({
          cursorBlink: true,
          cursorStyle: "bar",
          fontSize: 13,
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
          theme: {
            background: "#09090b", // zinc-950
            foreground: "#fafafa",
            cursor: "#fafafa",
            selectionBackground: "#3f3f46",
            black: "#18181b",
            red: "#ef4444",
            green: "#22c55e",
            yellow: "#eab308",
            blue: "#3b82f6",
            magenta: "#a855f7",
            cyan: "#06b6d4",
            white: "#fafafa",
            brightBlack: "#52525b",
            brightRed: "#f87171",
            brightGreen: "#4ade80",
            brightYellow: "#facc15",
            brightBlue: "#60a5fa",
            brightMagenta: "#c084fc",
            brightCyan: "#22d3ee",
            brightWhite: "#ffffff",
          },
          allowProposedApi: true,
        });

        const fitAddon = new FitAddon();
        const webLinksAddon = new WebLinksAddon();

        term.loadAddon(fitAddon);
        term.loadAddon(webLinksAddon);

        term.open(terminalRef.current);
        fitAddon.fit();

        xtermRef.current = term;
        fitAddonRef.current = fitAddon;
      }

      const term = xtermRef.current;
      if (!term) return;

      // Clear terminal for new session
      term.clear();
      term.reset();

      setStatus("connecting");
      setErrorMessage(null);

      // Connect SSE for output
      const url = `${baseUrl}/terminal?container=${encodeURIComponent(containerId)}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.addEventListener("session", (e) => {
        const data = JSON.parse(e.data) as {
          sessionId: string;
          containerId: string;
          containerName: string;
        };
        sessionIdRef.current = data.sessionId;
        setStatus("connected");

        // Send initial resize
        const fitAddon = fitAddonRef.current;
        if (fitAddon) {
          fitAddon.fit();
          sendResize(term.cols, term.rows);
        }
      });

      es.addEventListener("output", (e) => {
        const b64 = JSON.parse(e.data) as string;
        // Decode base64 to binary string, then write
        const bytes = atob(b64);
        term.write(bytes);
      });

      es.addEventListener("exit", () => {
        setStatus("disconnected");
        term.writeln("\r\n\x1b[90m[Session ended]\x1b[0m");
        sessionIdRef.current = null;
      });

      es.addEventListener("error", (e) => {
        // SSE error event — check if it's a message or connection error
        if (e instanceof MessageEvent) {
          const data = JSON.parse(e.data) as { message: string };
          setErrorMessage(data.message);
        }
        setStatus("error");
        sessionIdRef.current = null;
      });

      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          setStatus("disconnected");
        } else {
          setStatus("error");
        }
      };

      // Handle user input
      term.onData((data) => {
        sendInput(data);
      });
    },
    [baseUrl, sendInput, sendResize],
  );

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      const fitAddon = fitAddonRef.current;
      const term = xtermRef.current;
      if (fitAddon && term) {
        fitAddon.fit();
        if (sessionIdRef.current) {
          sendResize(term.cols, term.rows);
        }
      }
    };

    window.addEventListener("resize", handleResize);

    // Also observe the container for resize
    const el = terminalRef.current;
    let observer: ResizeObserver | null = null;
    if (el) {
      observer = new ResizeObserver(() => {
        handleResize();
      });
      observer.observe(el);
    }

    return () => {
      window.removeEventListener("resize", handleResize);
      observer?.disconnect();
    };
  }, [sendResize]);

  // Auto-connect when a container is selected
  useEffect(() => {
    if (selectedContainer && !loadingContainers) {
      connect(selectedContainer);
    }
  }, [selectedContainer, connect, loadingContainers]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const handleReconnect = () => {
    if (selectedContainer) {
      connect(selectedContainer);
    }
  };

  const handleContainerChange = (value: string) => {
    setSelectedContainer(value);
  };

  // Loading state
  if (loadingContainers) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading containers...</p>
      </div>
    );
  }

  // No containers
  if (containers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-12">
        <p className="text-sm text-muted-foreground">
          {errorMessage || "No running containers found. Deploy the project first."}
        </p>
        <Button size="sm" variant="outline" onClick={fetchContainers}>
          <RotateCcw className="mr-1.5 size-4" />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          {containers.length > 1 && (
            <Select value={selectedContainer || ""} onValueChange={handleContainerChange}>
              <SelectTrigger className="w-64 font-mono text-xs">
                <SelectValue placeholder="Select container" />
              </SelectTrigger>
              <SelectContent>
                {containers.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="font-mono text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {containers.length === 1 && (
            <span className="text-xs font-mono text-muted-foreground">
              {containers[0].name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${
                status === "connected"
                  ? "bg-status-success"
                  : status === "connecting"
                    ? "bg-status-warning animate-pulse"
                    : status === "error"
                      ? "bg-status-error"
                      : "bg-status-neutral"
              }`}
            />
            <span className="text-xs text-muted-foreground capitalize">{status}</span>
          </div>
          {(status === "disconnected" || status === "error") && (
            <Button size="sm" variant="outline" onClick={handleReconnect}>
              <RotateCcw className="mr-1.5 size-4" />
              Reconnect
            </Button>
          )}
        </div>
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="rounded-lg border border-status-error/30 bg-status-error-muted px-4 py-2">
          <p className="text-sm text-status-error">{errorMessage}</p>
        </div>
      )}

      {/* Terminal */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        <div
          ref={terminalRef}
          className="p-2"
          style={{ minHeight: "400px" }}
        />
      </div>
    </div>
  );
}

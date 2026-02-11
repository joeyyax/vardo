"use client";

import { useEffect, useRef } from "react";

type AuthResult =
  | { type: "scope-auth"; authenticated: false }
  | {
      type: "scope-auth";
      authenticated: true;
      user?: { id: string; name: string; email: string };
      scopeClientId?: string;
      organizationId: string;
      clientId: string;
      defaultProjectId?: string;
      publicAccess: boolean;
    };

export function BridgeClient({ auth }: { auth: AuthResult }) {
  const sentAuth = useRef(false);

  useEffect(() => {
    // Post auth result to parent once
    if (!sentAuth.current) {
      sentAuth.current = true;

      if (auth.authenticated && auth.defaultProjectId) {
        // Eagerly fetch existing reports to include with auth response
        fetchReports(auth.organizationId, auth.defaultProjectId).then((reports) => {
          window.parent.postMessage({ ...auth, reports }, "*");
        });
      } else {
        window.parent.postMessage(auth, "*");
      }
    }

    // Listen for API proxy requests from the widget on the host page
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data?.type) return;

      if (data.type === "submit-report") {
        submitReport(data.payload, event.source as Window);
      } else if (data.type === "fetch-reports") {
        fetchReports(data.organizationId, data.projectId).then((reports) => {
          (event.source as Window).postMessage(
            { type: "scope-reports", reports },
            "*"
          );
        });
      } else if (data.type === "send-heartbeat") {
        sendHeartbeat(data.payload);
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [auth]);

  return null;
}

async function fetchReports(organizationId: string, projectId: string) {
  try {
    const res = await fetch(
      `/api/v1/bug-reports?organizationId=${organizationId}&projectId=${projectId}`
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function submitReport(
  payload: {
    organizationId: string;
    projectId: string;
    clientId: string;
    scopeClientId?: string;
    description: string;
    pageUrl: string;
    metadata: Record<string, unknown>;
    screenshots: Array<{
      dataUrl: string;
      selectionRect: { x: number; y: number; width: number; height: number };
      expandedRect: { x: number; y: number; width: number; height: number };
    }>;
  },
  source: Window
) {
  try {
    const res = await fetch("/api/v1/bug-reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    if (!res.ok) {
      source.postMessage(
        { type: "scope-submit-result", success: false, error: data.error },
        "*"
      );
      return;
    }

    source.postMessage(
      {
        type: "scope-submit-result",
        success: true,
        report: data.report,
      },
      "*"
    );
  } catch {
    source.postMessage(
      { type: "scope-submit-result", success: false, error: "Network error" },
      "*"
    );
  }
}

async function sendHeartbeat(payload: Record<string, unknown>) {
  try {
    await fetch("/api/v1/heartbeats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Fire-and-forget, ignore errors
  }
}

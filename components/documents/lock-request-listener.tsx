"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";

type LockRequestListenerProps = {
  orgId: string;
  projectId: string;
  documentId: string;
  /** Called when the user accepts a transfer request */
  onAcceptTransfer: () => Promise<void>;
};

/**
 * Connects to the SSE endpoint when the current user holds the lock.
 * Displays a toast when another user requests edit access.
 */
export function LockRequestListener({
  orgId,
  projectId,
  documentId,
  onAcceptTransfer,
}: LockRequestListenerProps) {
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const url = `/api/v1/organizations/${orgId}/projects/${projectId}/documents/${documentId}/lock/poll`;
    const es = new EventSource(url);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === "edit_request") {
          toast(`${data.requesterName} is requesting edit access`, {
            duration: 30_000,
            action: {
              label: "Accept",
              onClick: () => {
                onAcceptTransfer();
              },
            },
          });
        }
      } catch {
        // Ignore non-JSON messages (keepalives)
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do here
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [orgId, projectId, documentId, onAcceptTransfer]);

  return null;
}

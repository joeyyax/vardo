import type { AuthResponse, SubmitPayload, SubmitResult, HeartbeatPayload } from "./types";

export class BridgeClient {
  private iframe: HTMLIFrameElement;
  private ready = false;
  private pendingCallbacks = new Map<string, (data: unknown) => void>();

  constructor(private apiUrl: string, private token: string) {
    this.iframe = document.createElement("iframe");
    this.iframe.style.display = "none";
    this.iframe.src = `${apiUrl}/widget/bridge?token=${token}`;
    document.body.appendChild(this.iframe);

    window.addEventListener("message", this.handleMessage);
  }

  /** Wait for the bridge auth response */
  waitForAuth(): Promise<AuthResponse> {
    return new Promise((resolve) => {
      this.pendingCallbacks.set("auth", (data) => {
        this.ready = true;
        resolve(data as AuthResponse);
      });
    });
  }

  /** Submit a bug report through the bridge */
  submitReport(payload: SubmitPayload): Promise<SubmitResult> {
    return new Promise((resolve) => {
      this.pendingCallbacks.set("submit", (data) =>
        resolve(data as SubmitResult)
      );
      this.postToBridge({ type: "submit-report", payload });
    });
  }

  /** Fetch latest reports through the bridge */
  fetchReports(organizationId: string, projectId: string): Promise<unknown[]> {
    return new Promise((resolve) => {
      this.pendingCallbacks.set("reports", (data) => {
        const msg = data as { reports?: unknown[] };
        resolve(msg.reports || []);
      });
      this.postToBridge({
        type: "fetch-reports",
        organizationId,
        projectId,
      });
    });
  }

  /** Send a heartbeat — fire-and-forget, no response expected */
  sendHeartbeat(payload: HeartbeatPayload): void {
    this.postToBridge({ type: "send-heartbeat", payload });
  }

  destroy() {
    window.removeEventListener("message", this.handleMessage);
    this.iframe.remove();
  }

  private handleMessage = (event: MessageEvent) => {
    const data = event.data;
    if (!data?.type) return;

    if (data.type === "scope-auth") {
      const cb = this.pendingCallbacks.get("auth");
      if (cb) {
        this.pendingCallbacks.delete("auth");
        cb(data);
      }
    } else if (data.type === "scope-submit-result") {
      const cb = this.pendingCallbacks.get("submit");
      if (cb) {
        this.pendingCallbacks.delete("submit");
        cb(data);
      }
    } else if (data.type === "scope-reports") {
      const cb = this.pendingCallbacks.get("reports");
      if (cb) {
        this.pendingCallbacks.delete("reports");
        cb(data);
      }
    }
  };

  private postToBridge(data: unknown) {
    this.iframe.contentWindow?.postMessage(data, this.apiUrl);
  }
}

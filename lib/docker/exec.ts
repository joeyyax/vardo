import http from "node:http";
import net from "node:net";
import { getConnectionOptions, DOCKER_API_VERSION } from "./client";

// ---------------------------------------------------------------------------
// Create exec instance
// ---------------------------------------------------------------------------

export async function createExec(
  containerId: string,
  cmd: string[] = ["/bin/sh"],
): Promise<string> {
  const conn = getConnectionOptions();
  const payload = JSON.stringify({
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Env: ["TERM=xterm-256color"],
    Cmd: cmd,
  });

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v${DOCKER_API_VERSION}/containers/${containerId}/exec`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode && res.statusCode >= 400) {
            let message = raw;
            try {
              const parsed = JSON.parse(raw);
              message = parsed.message ?? raw;
            } catch {
              // keep raw
            }
            reject(new Error(`Docker exec create failed (${res.statusCode}): ${message}`));
            return;
          }

          try {
            const data = JSON.parse(raw) as { Id: string };
            resolve(data.Id);
          } catch {
            reject(new Error(`Failed to parse exec create response: ${raw}`));
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error(`Docker exec create request failed: ${err.message}`));
    });

    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Start exec and return raw bidirectional socket
// ---------------------------------------------------------------------------

export async function startExec(execId: string): Promise<net.Socket> {
  const conn = getConnectionOptions();
  const payload = JSON.stringify({
    Detach: false,
    Tty: true,
  });

  // Build raw HTTP request — we need the raw socket because Docker hijacks
  // the connection for bidirectional TTY I/O, which http.request can't handle
  const httpReq = [
    `POST /v${DOCKER_API_VERSION}/exec/${execId}/start HTTP/1.1`,
    `Host: localhost`,
    `Content-Type: application/json`,
    `Content-Length: ${Buffer.byteLength(payload)}`,
    `Connection: Upgrade`,
    `Upgrade: tcp`,
    ``,
    payload,
  ].join("\r\n");

  return new Promise<net.Socket>((resolve, reject) => {
    const socket = conn.socketPath
      ? net.connect({ path: conn.socketPath })
      : net.connect({ host: conn.host!, port: conn.port! });

    let resolved = false;
    let headerBuf = Buffer.alloc(0);

    socket.on("connect", () => {
      socket.write(httpReq);
    });

    socket.on("data", (chunk: Buffer) => {
      if (resolved) return; // Already handed off

      // Accumulate chunks until we have the full HTTP headers
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const str = headerBuf.toString();
      const headerEnd = str.indexOf("\r\n\r\n");
      if (headerEnd === -1) return; // Haven't received full headers yet

      // Check for 200 OK or 101 Switching Protocols
      const statusLine = str.split("\r\n")[0];
      if (!statusLine.includes("200") && !statusLine.includes("101")) {
        reject(new Error(`Docker exec start failed: ${statusLine}`));
        socket.destroy();
        return;
      }

      resolved = true;

      // Any data after the headers is already terminal output
      const bodyStartByte = Buffer.byteLength(str.substring(0, headerEnd + 4));
      const remaining = headerBuf.subarray(bodyStartByte);

      // Remove our initial data listener and resolve with the raw socket
      socket.removeAllListeners("data");

      // Re-emit the remaining data so the caller gets it
      if (remaining.length > 0) {
        process.nextTick(() => socket.emit("data", remaining));
      }

      resolve(socket);
    });

    socket.on("error", (err) => {
      if (!resolved) {
        reject(new Error(`Docker exec start socket error: ${err.message}`));
      }
    });

    socket.on("close", () => {
      if (!resolved) {
        reject(new Error("Docker exec start: socket closed before response"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Resize exec TTY
// ---------------------------------------------------------------------------

export async function resizeExec(
  execId: string,
  cols: number,
  rows: number,
): Promise<void> {
  const conn = getConnectionOptions();
  const params = new URLSearchParams({ h: String(rows), w: String(cols) });

  return new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v${DOCKER_API_VERSION}/exec/${execId}/resize?${params}`,
        method: "POST",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            const raw = Buffer.concat(chunks).toString("utf-8");
            reject(new Error(`Docker exec resize failed (${res.statusCode}): ${raw}`));
            return;
          }
          resolve();
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error(`Docker exec resize request failed: ${err.message}`));
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Inspect exec (check if still running)
// ---------------------------------------------------------------------------

export async function inspectExec(
  execId: string,
): Promise<{ running: boolean; exitCode: number | null }> {
  const conn = getConnectionOptions();

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v${DOCKER_API_VERSION}/exec/${execId}/json`,
        method: "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Docker exec inspect failed (${res.statusCode}): ${raw}`));
            return;
          }
          try {
            const data = JSON.parse(raw) as { Running: boolean; ExitCode: number };
            resolve({ running: data.Running, exitCode: data.ExitCode });
          } catch {
            reject(new Error(`Failed to parse exec inspect response: ${raw}`));
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error(`Docker exec inspect request failed: ${err.message}`));
    });

    req.end();
  });
}

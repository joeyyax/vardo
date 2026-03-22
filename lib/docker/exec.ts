import http from "node:http";
import net from "node:net";

// ---------------------------------------------------------------------------
// Connection helpers (mirrors client.ts)
// ---------------------------------------------------------------------------

function getConnectionOptions(): { socketPath?: string; host?: string; port?: number } {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    const url = new URL(dockerHost);
    return { host: url.hostname, port: Number(url.port) || 2375 };
  }
  return { socketPath: "/var/run/docker.sock" };
}

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
    Cmd: cmd,
  });

  return new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v1.43/containers/${containerId}/exec`,
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

  return new Promise<net.Socket>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v1.43/exec/${execId}/start`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      },
      (res) => {
        // If we get a normal response instead of an upgrade, we can still
        // use the socket — Docker returns 200 with a hijacked connection
        // for TTY exec sessions.
        if (res.statusCode === 200) {
          // The underlying socket is hijacked for bidirectional I/O
          const socket = (res as unknown as { socket: net.Socket }).socket;
          if (socket) {
            resolve(socket);
            return;
          }
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          reject(new Error(`Docker exec start failed (${res.statusCode}): ${raw}`));
        });
      },
    );

    // Docker hijacks the connection on upgrade
    req.on("upgrade", (_res, socket) => {
      resolve(socket as net.Socket);
    });

    req.on("error", (err) => {
      reject(new Error(`Docker exec start request failed: ${err.message}`));
    });

    req.write(payload);
    req.end();
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
        path: `/v1.43/exec/${execId}/resize?${params}`,
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
        path: `/v1.43/exec/${execId}/json`,
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

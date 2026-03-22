import http from "node:http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ContainerInfo = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: { internal: number; external?: number; protocol: string }[];
  labels: Record<string, string>;
};

export type ContainerInspect = {
  id: string;
  name: string;
  state: { running: boolean; status: string; startedAt: string };
  image: string;
  ports: { internal: number; external?: number; protocol: string }[];
  env: string[];
  labels: Record<string, string>;
  networks: string[];
  mounts: { source: string; destination: string; type: string }[];
};

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

function getConnectionOptions(): { socketPath?: string; host?: string; port?: number } {
  const dockerHost = process.env.DOCKER_HOST;
  if (dockerHost) {
    // tcp://host:port
    const url = new URL(dockerHost);
    return { host: url.hostname, port: Number(url.port) || 2375 };
  }
  return { socketPath: "/var/run/docker.sock" };
}

// ---------------------------------------------------------------------------
// Low-level request helper
// ---------------------------------------------------------------------------

export async function dockerRequest<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const conn = getConnectionOptions();
  const payload = body ? JSON.stringify(body) : undefined;

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        ...conn,
        path: `/v1.43${path}`,
        method,
        headers: {
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
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
              // keep raw string
            }
            reject(
              new Error(`Docker API ${method} ${path} returned ${res.statusCode}: ${message}`),
            );
            return;
          }

          // Some endpoints return empty 204 responses
          if (!raw || raw.length === 0) {
            resolve(undefined as T);
            return;
          }

          try {
            resolve(JSON.parse(raw) as T);
          } catch {
            // Return raw text (e.g. logs endpoint)
            resolve(raw as T);
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(
        new Error(
          `Docker API request failed: ${err.message}. Is the Docker daemon running?`,
        ),
      );
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

export async function isDockerAvailable(): Promise<boolean> {
  try {
    await dockerRequest("GET", "/_ping");
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

export async function ensureNetwork(name: string): Promise<void> {
  // Check if network already exists
  const networks = await dockerRequest<{ Name: string }[]>(
    "GET",
    `/networks?filters=${encodeURIComponent(JSON.stringify({ name: [name] }))}`,
  );

  const exists = networks.some((n) => n.Name === name);
  if (exists) return;

  await dockerRequest("POST", "/networks/create", {
    Name: name,
    Driver: "bridge",
    CheckDuplicate: true,
  });
}

// ---------------------------------------------------------------------------
// Port parsing helpers
// ---------------------------------------------------------------------------

type ParsedPort = { internal: number; external?: number; protocol: string };

function parseListPorts(
  portsArray?: { PrivatePort: number; PublicPort?: number; Type: string }[],
): ParsedPort[] {
  if (!portsArray) return [];
  return portsArray.map((p) => ({
    internal: p.PrivatePort,
    external: p.PublicPort || undefined,
    protocol: p.Type,
  }));
}

function parseInspectPorts(
  portBindings?: Record<string, { HostPort: string }[] | null>,
): ParsedPort[] {
  if (!portBindings) return [];
  const ports: ParsedPort[] = [];

  for (const [containerPort, hostBindings] of Object.entries(portBindings)) {
    // containerPort is like "8080/tcp"
    const [portStr, protocol] = containerPort.split("/");
    const internal = parseInt(portStr, 10);

    if (hostBindings && hostBindings.length > 0) {
      for (const binding of hostBindings) {
        ports.push({
          internal,
          external: binding.HostPort ? parseInt(binding.HostPort, 10) : undefined,
          protocol: protocol || "tcp",
        });
      }
    } else {
      ports.push({ internal, protocol: protocol || "tcp" });
    }
  }

  return ports;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export async function listContainers(projectLabel?: string): Promise<ContainerInfo[]> {
  const filters: Record<string, string[]> = {};
  if (projectLabel) {
    filters.label = [`host.project=${projectLabel}`];
  }

  const query = Object.keys(filters).length
    ? `?filters=${encodeURIComponent(JSON.stringify(filters))}`
    : "";

  const containers = await dockerRequest<
    {
      Id: string;
      Names: string[];
      Image: string;
      State: string;
      Status: string;
      Ports: { PrivatePort: number; PublicPort?: number; Type: string }[];
      Labels: Record<string, string>;
    }[]
  >("GET", `/containers/json${query}`);

  return containers.map((c) => ({
    id: c.Id,
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    image: c.Image,
    state: c.State,
    status: c.Status,
    ports: parseListPorts(c.Ports),
    labels: c.Labels ?? {},
  }));
}

export async function inspectContainer(id: string): Promise<ContainerInspect> {
  const data = await dockerRequest<{
    Id: string;
    Name: string;
    State: { Running: boolean; Status: string; StartedAt: string };
    Config: {
      Image: string;
      Env: string[];
      Labels: Record<string, string>;
    };
    HostConfig: {
      PortBindings?: Record<string, { HostPort: string }[] | null>;
    };
    NetworkSettings: {
      Networks?: Record<string, unknown>;
    };
    Mounts: { Source: string; Destination: string; Type: string }[];
  }>("GET", `/containers/${id}/json`);

  return {
    id: data.Id,
    name: data.Name.replace(/^\//, ""),
    state: {
      running: data.State.Running,
      status: data.State.Status,
      startedAt: data.State.StartedAt,
    },
    image: data.Config.Image,
    ports: parseInspectPorts(data.HostConfig.PortBindings),
    env: data.Config.Env ?? [],
    labels: data.Config.Labels ?? {},
    networks: Object.keys(data.NetworkSettings.Networks ?? {}),
    mounts: (data.Mounts ?? []).map((m) => ({
      source: m.Source,
      destination: m.Destination,
      type: m.Type,
    })),
  };
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function getContainerLogs(
  id: string,
  opts?: { tail?: number; since?: string },
): Promise<string> {
  const tail = opts?.tail ?? 100;
  const params = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    tail: String(tail),
  });
  if (opts?.since) {
    params.set("since", opts.since);
  }

  const raw = await dockerRequest<string>("GET", `/containers/${id}/logs?${params.toString()}`);

  // Docker multiplexed stream: each frame has an 8-byte header.
  // Strip the headers to return clean log text.
  if (typeof raw === "string") {
    return stripDockerLogHeaders(raw);
  }
  return "";
}

function stripDockerLogHeaders(raw: string): string {
  // Docker stream protocol: 8-byte header per frame (type[1] + padding[3] + size[4]).
  // For simple cases where the response is already plain text, return as-is.
  // The binary header starts with \x01 (stdout) or \x02 (stderr).
  const firstChar = raw.charCodeAt(0);
  if (firstChar !== 0 && firstChar !== 1 && firstChar !== 2) {
    return raw;
  }

  const lines: string[] = [];
  let offset = 0;
  const buf = Buffer.from(raw, "binary");

  while (offset < buf.length) {
    if (offset + 8 > buf.length) break;
    const frameSize = buf.readUInt32BE(offset + 4);
    offset += 8;
    if (offset + frameSize > buf.length) break;
    lines.push(buf.subarray(offset, offset + frameSize).toString("utf-8"));
    offset += frameSize;
  }

  return lines.join("");
}

// ---------------------------------------------------------------------------
// Port detection
// ---------------------------------------------------------------------------

export async function detectExposedPorts(imageOrId: string): Promise<number[]> {
  // Try image inspect first, fall back to container inspect
  let exposedPorts: Record<string, unknown> | undefined;

  try {
    const image = await dockerRequest<{
      Config?: { ExposedPorts?: Record<string, unknown> };
      ContainerConfig?: { ExposedPorts?: Record<string, unknown> };
    }>("GET", `/images/${encodeURIComponent(imageOrId)}/json`);

    exposedPorts = image.Config?.ExposedPorts ?? image.ContainerConfig?.ExposedPorts;
  } catch {
    // Might be a container ID instead
    const container = await inspectContainer(imageOrId);
    return container.ports.map((p) => p.internal);
  }

  if (!exposedPorts) return [];

  return Object.keys(exposedPorts).map((key) => {
    // key is like "8080/tcp"
    return parseInt(key.split("/")[0], 10);
  });
}

// JSON API client for the collector (`/health`, `/api/v1/host`, `/api/v1/containers`).

const TIMEOUT_MS = 5000;

export type CollectorContainer = {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  pid: number;
  network_mode: string;
  started_at: string;
  created: string;
  cpu: {
    usage_seconds_total: number;
    /** Null after the collector's first collection and after a counter reset. */
    usage_cores: number | null;
    limit_cores: number | null;
    throttled_periods_total: number;
    throttled_seconds_total: number;
  };
  memory: {
    usage_bytes: number;
    working_set_bytes: number;
    peak_bytes: number | null;
    limit_bytes: number | null;
    rss_bytes: number;
    cache_bytes: number;
    swap_bytes: number;
    oom_kills_total: number;
  };
  io: { device: string; read_bytes_total: number; write_bytes_total: number }[];
  network: {
    interface: string;
    receive_bytes_total: number;
    transmit_bytes_total: number;
    receive_bytes_per_second: number | null;
    transmit_bytes_per_second: number | null;
  }[];
  pids: { current: number; limit: number | null };
};

export type CollectorGpu = {
  index: number;
  uuid: string;
  name: string;
  temperature_celsius: number | null;
  utilization_ratio: number | null;
  memory_utilization_ratio: number | null;
  memory_used_bytes: number | null;
  memory_total_bytes: number | null;
  power_draw_watts: number | null;
  fan_speed_ratio: number | null;
};

/** The slice of `/api/v1/host` Vardo reads. */
export type CollectorHost = {
  host: string;
  /** Epoch seconds of the collection. */
  timestamp: number;
  gpus?: CollectorGpu[];
};

export type CollectorHealth = {
  status: "ok" | "stale";
  version: string;
  host: string;
  last_collect_age_seconds: number | null;
  docker?: boolean;
};

export class CollectorHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`collector ${path} returned ${status}`);
  }
}

/** Resolves the bearer token per request, so a token written after startup is picked up. */
export type TokenSource = () => Promise<string | null>;

export class CollectorClient {
  constructor(
    readonly url: string,
    private readonly token: TokenSource = async () => null,
  ) {}

  containers(): Promise<CollectorContainer[]> {
    return this.get("/api/v1/containers");
  }

  host(): Promise<CollectorHost> {
    return this.get("/api/v1/host");
  }

  /** Resolves on 503 too: a stale collector still answers with its age. */
  async health(): Promise<CollectorHealth> {
    const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok && res.status !== 503) throw new CollectorHttpError(res.status, "/health");
    return (await res.json()) as CollectorHealth;
  }

  private async get<T>(path: string): Promise<T> {
    const token = await this.token();
    const res = await fetch(`${this.url}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new CollectorHttpError(res.status, path);
    return (await res.json()) as T;
  }
}

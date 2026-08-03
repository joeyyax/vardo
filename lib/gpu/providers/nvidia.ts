import { execFile } from "node:child_process";
import { logger } from "@/lib/logger";
import type { GpuDevice, GpuDeviceMetrics, GpuProcess, GpuProvider } from "../types";

const log = logger.child("gpu-nvidia");

const MiB = 1024 * 1024;

/**
 * Docker image used when nvidia-smi isn't available locally.
 * The Vardo container typically doesn't have the NVIDIA runtime,
 * but it has the Docker socket — so we spawn a GPU-enabled container
 * to run nvidia-smi and capture the output.
 */
const NVIDIA_SMI_IMAGE = "nvidia/cuda:12.8.1-base-ubuntu24.04";

/** Fixed name, so at most one probe container can exist however a run ends. */
export const PROBE_CONTAINER_NAME = "vardo-gpu-probe";

const DEVICE_FIELDS =
  "index,uuid,name,memory.total,utilization.gpu,memory.used,temperature.gpu,power.draw,fan.speed";
const PROCESS_FIELDS = "pid,gpu_uuid,used_gpu_memory";
const CSV_FORMAT = "--format=csv,noheader,nounits";

/** Separates the device rows from the process rows in one probe's output. */
export const SECTION_MARKER = "__vardo_gpu_processes__";

/** How long one probe's output is reused, so a collector tick costs a single run. */
export const SNAPSHOT_TTL_MS = 5_000;

/** Whole-probe budget, kept under the collector's 15s GPU timeout. */
const PROBE_BUDGET_MS = 10_000;
const STEP_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 250;
const LOCAL_TIMEOUT_MS = 5_000;

/** Consecutive probe failures before the breaker opens. */
export const FAILURE_THRESHOLD = 3;

/** How long probing stays off once the breaker opens. */
export const BREAKER_COOLDOWN_MS = 30 * 60_000;

export type CommandResult = { ok: true; stdout: string } | { ok: false; code?: string };

/** Runs a command to completion. Never rejects — failures come back as ok: false. */
export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<CommandResult>;

type GpuSnapshot = { devices: string[]; processes: string[] };

/** Execution mode — detected once on first call. */
type ExecMode = "local" | "docker";

/**
 * NVIDIA GPU provider — uses nvidia-smi CSV output.
 *
 * Tries nvidia-smi locally first. If not available (ENOENT), falls back to a
 * GPU-enabled container started through the Docker socket.
 *
 * Every query is served from one probe per tick: concurrent callers share the
 * in-flight run, and the result is reused for SNAPSHOT_TTL_MS.
 */
export class NvidiaProvider implements GpuProvider {
  readonly vendor = "nvidia" as const;

  private readonly run: CommandRunner;
  private execMode: ExecMode | null = null;
  private cache: { at: number; snapshot: GpuSnapshot | null } | null = null;
  private inFlight: Promise<GpuSnapshot | null> | null = null;
  private consecutiveFailures = 0;
  private openUntil = 0;
  private breakerOpen = false;

  constructor(run: CommandRunner = execCommand) {
    this.run = run;
  }

  async detectDevices(): Promise<GpuDevice[]> {
    const snapshot = await this.snapshot();
    return (snapshot?.devices ?? []).map(parseDevice).filter(isPresent);
  }

  async getDeviceMetrics(): Promise<GpuDeviceMetrics[]> {
    const snapshot = await this.snapshot();
    return (snapshot?.devices ?? []).map(parseDeviceMetrics).filter(isPresent);
  }

  async getProcesses(): Promise<GpuProcess[]> {
    const snapshot = await this.snapshot();
    if (!snapshot) return [];

    const uuidToIndex = new Map(
      snapshot.devices.map(parseDevice).filter(isPresent).map((d) => [d.uuid, d.index]),
    );

    return snapshot.processes
      .map((line) => {
        const [pid, uuid, memMiB] = splitCsv(line);
        if (memMiB === undefined) return null;
        return {
          pid: parseInt(pid, 10),
          deviceIndex: uuidToIndex.get(uuid) ?? 0,
          memoryUsed: parseNum(memMiB) * MiB,
          type: "compute" as const,
        };
      })
      .filter(isPresent);
  }

  /** True while the breaker is holding probes off. */
  isProbeDisabled(): boolean {
    return Date.now() < this.openUntil;
  }

  /**
   * Latest nvidia-smi output — cached, single-flight, and skipped entirely
   * while the breaker is open.
   */
  private snapshot(): Promise<GpuSnapshot | null> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < SNAPSHOT_TTL_MS) {
      return Promise.resolve(this.cache.snapshot);
    }
    if (this.inFlight) return this.inFlight;
    if (now < this.openUntil) return Promise.resolve(null);

    this.inFlight = this.probe()
      .then((snapshot) => {
        this.record(snapshot);
        this.cache = { at: Date.now(), snapshot };
        return snapshot;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Track consecutive failures and open the breaker once they pile up. */
  private record(snapshot: GpuSnapshot | null): void {
    if (snapshot) {
      if (this.breakerOpen) log.info("GPU probe recovered");
      this.consecutiveFailures = 0;
      this.openUntil = 0;
      this.breakerOpen = false;
      return;
    }

    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;

    this.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    if (!this.breakerOpen) {
      this.breakerOpen = true;
      log.warn(
        `GPU probing paused after ${this.consecutiveFailures} consecutive failures — ` +
          `retrying in ${Math.round(BREAKER_COOLDOWN_MS / 60_000)}m`,
      );
    }
  }

  private async probe(): Promise<GpuSnapshot | null> {
    if (this.execMode !== "docker") {
      const local = await this.probeLocal();
      if (local !== undefined) {
        this.execMode = "local";
        return local;
      }
      if (this.execMode === null) {
        log.info("nvidia-smi not found locally, using Docker socket fallback");
      }
      this.execMode = "docker";
    }
    return this.probeDocker();
  }

  /** Returns undefined when the nvidia-smi binary isn't installed. */
  private async probeLocal(): Promise<GpuSnapshot | null | undefined> {
    const devices = await this.run(
      "nvidia-smi",
      [`--query-gpu=${DEVICE_FIELDS}`, CSV_FORMAT],
      LOCAL_TIMEOUT_MS,
    );
    if (!devices.ok) return devices.code === "ENOENT" ? undefined : null;

    const deviceLines = parseLines(devices.stdout);
    if (!deviceLines) return null;

    const processes = await this.run(
      "nvidia-smi",
      [`--query-compute-apps=${PROCESS_FIELDS}`, CSV_FORMAT],
      LOCAL_TIMEOUT_MS,
    );
    return {
      devices: deviceLines,
      processes: processes.ok ? (parseLines(processes.stdout) ?? []) : [],
    };
  }

  /**
   * Run nvidia-smi in a GPU-enabled container via the Docker socket.
   *
   * Detached, so cleanup never depends on the CLI client surviving: the
   * container is force-removed before and after every probe, and the fixed
   * name means a leftover from a killed run is reclaimed rather than orphaned.
   */
  private async probeDocker(): Promise<GpuSnapshot | null> {
    const deadline = Date.now() + PROBE_BUDGET_MS;
    const script =
      `nvidia-smi --query-gpu=${DEVICE_FIELDS} ${CSV_FORMAT}; ` +
      `echo ${SECTION_MARKER}; ` +
      `nvidia-smi --query-compute-apps=${PROCESS_FIELDS} ${CSV_FORMAT}`;

    try {
      await this.removeProbeContainer();

      const started = await this.docker(
        [
          "run",
          "-d",
          "--name",
          PROBE_CONTAINER_NAME,
          "--gpus",
          "all",
          "--pid=host",
          NVIDIA_SMI_IMAGE,
          "sh",
          "-c",
          script,
        ],
        deadline,
      );
      if (!started.ok) return null;

      if (!(await this.waitForExit(deadline))) return null;

      const output = await this.docker(["logs", PROBE_CONTAINER_NAME], deadline);
      return output.ok ? splitSections(output.stdout) : null;
    } finally {
      await this.removeProbeContainer();
    }
  }

  /** Poll until the probe container exits, within the remaining budget. */
  private async waitForExit(deadline: number): Promise<boolean> {
    for (;;) {
      const status = await this.docker(
        ["inspect", "-f", "{{.State.Status}}", PROBE_CONTAINER_NAME],
        deadline,
      );
      if (!status.ok) return false;

      const state = status.stdout.trim();
      if (state === "exited") return true;
      if (state === "dead") return false;
      if (Date.now() >= deadline) return false;

      await sleep(POLL_INTERVAL_MS);
    }
  }

  private removeProbeContainer(): Promise<CommandResult> {
    return this.run("docker", ["rm", "-f", PROBE_CONTAINER_NAME], CLEANUP_TIMEOUT_MS);
  }

  private docker(args: string[], deadline: number): Promise<CommandResult> {
    const remaining = deadline - Date.now();
    return this.run("docker", args, Math.min(STEP_TIMEOUT_MS, Math.max(1_000, remaining)));
  }
}

// ---------------------------------------------------------------------------
// Execution backend
// ---------------------------------------------------------------------------

/**
 * SIGKILL on timeout — a wedged `docker run` ignores SIGTERM and the callback
 * would otherwise never fire.
 */
const execCommand: CommandRunner = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      if (err) {
        const code = (err as NodeJS.ErrnoException).code;
        resolve({ ok: false, code: typeof code === "string" ? code : undefined });
        return;
      }
      resolve({ ok: true, stdout });
    });
  });

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Split combined probe output into device rows and process rows. */
export function splitSections(stdout: string): GpuSnapshot | null {
  const marker = stdout.indexOf(SECTION_MARKER);
  const deviceBlock = marker === -1 ? stdout : stdout.slice(0, marker);
  const processBlock = marker === -1 ? "" : stdout.slice(marker + SECTION_MARKER.length);

  const devices = (parseLines(deviceBlock) ?? []).filter((l) => splitCsv(l).length >= 9);
  if (devices.length === 0) return null;

  const processes = (parseLines(processBlock) ?? []).filter((l) => splitCsv(l).length === 3);
  return { devices, processes };
}

function parseDevice(line: string): GpuDevice | null {
  const [index, uuid, name, memTotal] = splitCsv(line);
  if (memTotal === undefined) return null;
  return {
    index: parseInt(index, 10),
    uuid,
    name,
    memoryTotal: parseNum(memTotal) * MiB,
    vendor: "nvidia" as const,
  };
}

function parseDeviceMetrics(line: string): GpuDeviceMetrics | null {
  const device = parseDevice(line);
  if (!device) return null;

  const [, , , , util, memUsed, temp, power, fan] = splitCsv(line);
  return {
    device,
    utilization: parseNum(util),
    memoryUsed: parseNum(memUsed) * MiB,
    memoryTotal: device.memoryTotal,
    temperature: parseNum(temp),
    powerDraw: parseNum(power),
    fanSpeed: parseNum(fan),
  };
}

function parseLines(stdout: string): string[] | null {
  const lines = stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 ? lines : null;
}

function splitCsv(line: string): string[] {
  return line.split(",").map((f) => f.trim());
}

function parseNum(val: string | undefined): number {
  const n = parseFloat(val ?? "");
  return Number.isNaN(n) ? 0 : n;
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

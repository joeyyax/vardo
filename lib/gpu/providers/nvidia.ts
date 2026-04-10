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

/** Execution mode — detected once on first call. */
type ExecMode = "local" | "docker";

/**
 * NVIDIA GPU provider — uses nvidia-smi CSV output.
 *
 * Tries nvidia-smi locally first. If not available (ENOENT), falls back
 * to running it via `docker run --gpus all` using the Docker socket.
 */
export class NvidiaProvider implements GpuProvider {
  readonly vendor = "nvidia" as const;

  private uuidToIndex: Map<string, number> | null = null;
  private execMode: ExecMode | null = null;

  async detectDevices(): Promise<GpuDevice[]> {
    const csv = await this.nvidiaSmi([
      "--query-gpu=index,uuid,name,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    if (!csv) return [];

    const devices = csv.map((line) => {
      const [index, uuid, name, memTotalMiB] = splitCsv(line);
      return {
        index: parseInt(index, 10),
        uuid: uuid.trim(),
        name: name.trim(),
        memoryTotal: parseFloat(memTotalMiB) * MiB,
        vendor: "nvidia" as const,
      };
    });

    this.uuidToIndex = new Map(devices.map((d) => [d.uuid, d.index]));
    return devices;
  }

  async getDeviceMetrics(): Promise<GpuDeviceMetrics[]> {
    const csv = await this.nvidiaSmi([
      "--query-gpu=index,uuid,name,memory.total,utilization.gpu,memory.used,temperature.gpu,power.draw,fan.speed",
      "--format=csv,noheader,nounits",
    ]);
    if (!csv) return [];

    return csv.map((line) => {
      const [index, uuid, name, memTotal, util, memUsed, temp, power, fan] = splitCsv(line);
      return {
        device: {
          index: parseInt(index, 10),
          uuid: uuid.trim(),
          name: name.trim(),
          memoryTotal: parseFloat(memTotal) * MiB,
          vendor: "nvidia" as const,
        },
        utilization: parseNum(util),
        memoryUsed: parseFloat(memUsed) * MiB,
        memoryTotal: parseFloat(memTotal) * MiB,
        temperature: parseNum(temp),
        powerDraw: parseNum(power),
        fanSpeed: parseNum(fan),
      };
    });
  }

  async getProcesses(): Promise<GpuProcess[]> {
    const csv = await this.nvidiaSmi([
      "--query-compute-apps=pid,gpu_uuid,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ]);
    if (!csv) return [];

    if (!this.uuidToIndex) {
      await this.detectDevices();
    }

    return csv.map((line) => {
      const [pid, uuid, memMiB] = splitCsv(line);
      return {
        pid: parseInt(pid, 10),
        deviceIndex: this.uuidToIndex?.get(uuid.trim()) ?? 0,
        memoryUsed: parseFloat(memMiB) * MiB,
        type: "compute" as const,
      };
    });
  }

  /**
   * Run nvidia-smi with auto-detection of execution mode.
   * First call probes local nvidia-smi; if not found, switches to Docker mode.
   */
  private async nvidiaSmi(args: string[]): Promise<string[] | null> {
    if (this.execMode === "docker") {
      return nvidiaSmiDocker(args);
    }

    // Try local first
    const result = await nvidiaSmiLocal(args);
    if (result !== undefined) {
      this.execMode = "local";
      return result;
    }

    // Local not available — try Docker
    log.info("nvidia-smi not found locally, using Docker socket fallback");
    this.execMode = "docker";
    return nvidiaSmiDocker(args);
  }
}

// ---------------------------------------------------------------------------
// Execution backends
// ---------------------------------------------------------------------------

/**
 * Run nvidia-smi locally. Returns parsed lines, null if no output,
 * or undefined if nvidia-smi binary is not found (ENOENT).
 */
function nvidiaSmiLocal(args: string[]): Promise<string[] | null | undefined> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          resolve(undefined); // binary not found — signal to try Docker
          return;
        }
        log.warn("nvidia-smi failed:", err.message);
        resolve(null);
        return;
      }
      resolve(parseLines(stdout));
    });
  });
}

/**
 * Run nvidia-smi via `docker run --gpus all` using the Docker socket.
 * The Vardo container has the socket mounted, so this spawns a short-lived
 * GPU-enabled container on the host to query NVIDIA devices.
 *
 * Uses --pid=host so process PIDs match the host namespace for cgroup mapping.
 */
function nvidiaSmiDocker(args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["run", "--rm", "--gpus", "all", "--pid=host", NVIDIA_SMI_IMAGE, "nvidia-smi", ...args],
      { timeout: 10_000 },
      (err, stdout) => {
        if (err) {
          log.warn("nvidia-smi (docker) failed:", err.message);
          resolve(null);
          return;
        }
        resolve(parseLines(stdout));
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseLines(stdout: string): string[] | null {
  const lines = stdout
    .trim()
    .split("\n")
    .filter((l) => l.trim().length > 0);
  return lines.length > 0 ? lines : null;
}

function splitCsv(line: string): string[] {
  return line.split(",").map((f) => f.trim());
}

function parseNum(val: string): number {
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

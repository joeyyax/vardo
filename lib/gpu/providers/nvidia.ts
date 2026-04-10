import { execFile } from "node:child_process";
import { logger } from "@/lib/logger";
import type { GpuDevice, GpuDeviceMetrics, GpuProcess, GpuProvider } from "../types";

const log = logger.child("gpu-nvidia");

const MiB = 1024 * 1024;

/**
 * NVIDIA GPU provider — uses nvidia-smi CSV output.
 *
 * nvidia-smi is available inside the Vardo container when running with
 * the nvidia runtime or with GPU device mounts.
 */
export class NvidiaProvider implements GpuProvider {
  readonly vendor = "nvidia" as const;

  // Device UUID→index mapping — stable across ticks, populated on first detectDevices()
  private uuidToIndex: Map<string, number> | null = null;

  async detectDevices(): Promise<GpuDevice[]> {
    const csv = await nvidiaSmi([
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

    // Cache UUID→index mapping (stable — GPUs don't change between ticks)
    this.uuidToIndex = new Map(devices.map((d) => [d.uuid, d.index]));

    return devices;
  }

  async getDeviceMetrics(): Promise<GpuDeviceMetrics[]> {
    const csv = await nvidiaSmi([
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
    const csv = await nvidiaSmi([
      "--query-compute-apps=pid,gpu_uuid,used_gpu_memory",
      "--format=csv,noheader,nounits",
    ]);
    if (!csv) return [];

    // Use cached UUID→index mapping (populated by detectDevices during init)
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run nvidia-smi with given args. Returns parsed CSV lines or null on failure. */
function nvidiaSmi(args: string[]): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", args, { timeout: 5000 }, (err, stdout) => {
      if (err) {
        // nvidia-smi not available or failed — not an error on non-GPU hosts
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          log.warn("nvidia-smi failed:", err.message);
        }
        resolve(null);
        return;
      }
      const lines = stdout
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      resolve(lines.length > 0 ? lines : null);
    });
  });
}

/** Split a CSV line, trimming each field. Handles nvidia-smi's space-after-comma format. */
function splitCsv(line: string): string[] {
  return line.split(",").map((f) => f.trim());
}

/** Parse a number, returning 0 for "[N/A]" or unparseable values. */
function parseNum(val: string): number {
  const n = parseFloat(val);
  return Number.isNaN(n) ? 0 : n;
}

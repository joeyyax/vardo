import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const PORT_RANGE_START = 32768;
const PORT_RANGE_END = 60999;

/**
 * Get all host ports currently in use by Docker containers.
 */
async function getUsedPorts(): Promise<Set<number>> {
  const used = new Set<number>();
  try {
    const { stdout } = await execAsync(
      "docker ps --format '{{.Ports}}' | grep -oE '0\\.0\\.0\\.0:[0-9]+' | cut -d: -f2",
      { timeout: 5000 }
    );
    for (const line of stdout.trim().split("\n")) {
      const port = parseInt(line);
      if (!isNaN(port)) used.add(port);
    }
  } catch { /* no containers or docker not running */ }
  return used;
}

/**
 * Allocate a random high port that isn't in use.
 */
export async function allocatePort(): Promise<number> {
  const used = await getUsedPorts();
  const range = PORT_RANGE_END - PORT_RANGE_START;

  for (let attempt = 0; attempt < 100; attempt++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * range);
    if (!used.has(port)) return port;
  }

  throw new Error("Could not allocate a free port");
}

/**
 * Allocate multiple ports at once, ensuring no conflicts.
 */
export async function allocatePorts(count: number): Promise<number[]> {
  const used = await getUsedPorts();
  const allocated: number[] = [];
  const range = PORT_RANGE_END - PORT_RANGE_START;

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const port = PORT_RANGE_START + Math.floor(Math.random() * range);
      if (!used.has(port) && !allocated.includes(port)) {
        allocated.push(port);
        break;
      }
    }
  }

  if (allocated.length !== count) {
    throw new Error(`Could only allocate ${allocated.length} of ${count} ports`);
  }

  return allocated;
}

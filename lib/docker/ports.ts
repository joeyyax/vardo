import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";

const PORT_RANGE_START = 32768;
const PORT_RANGE_END = 60999;

/** Host ports bound on 0.0.0.0 in `docker ps --format {{.Ports}}` output. */
export function parseHostPorts(output: string): Set<number> {
  const used = new Set<number>();
  for (const match of output.matchAll(/0\.0\.0\.0:(\d+)/g)) {
    used.add(parseInt(match[1], 10));
  }
  return used;
}

/** Host ports in use by Docker containers. */
async function getUsedPorts(): Promise<Set<number>> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.Ports}}"],
      { env: dockerEnv(), timeout: 5000 }
    );
    return parseHostPorts(stdout);
  } catch {
    return new Set();
  }
}

/** Allocate a random free high port. */
export async function allocatePort(): Promise<number> {
  const used = await getUsedPorts();
  const range = PORT_RANGE_END - PORT_RANGE_START;

  for (let attempt = 0; attempt < 100; attempt++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * range);
    if (!used.has(port)) return port;
  }

  throw new Error("Could not allocate a free port");
}

/** Allocate `count` distinct free high ports. */
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

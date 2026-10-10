// Samples a container's processes with `docker top` and its listening ports from the host's /proc. No exec.

import { readFile } from "fs/promises";
import { dockerRequest } from "@/lib/docker/client";
import { parseListening, parseTop, type TopProcess } from "./security";

const HOST_PROC = "/host-proc";
const TOP_ARGS = encodeURIComponent("-eo pid,comm,pcpu,rss");

export type ContainerProbe = { processes: TopProcess[]; ports: string[] | null };

async function readTable(pid: number, file: string): Promise<string | null> {
  try {
    return await readFile(`${HOST_PROC}/${pid}/net/${file}`, "utf-8");
  } catch {
    return null;
  }
}

/** Ports are null when the host's /proc isn't mounted. */
export async function probeContainer(containerId: string): Promise<ContainerProbe> {
  const reply = await dockerRequest<{ Titles?: string[]; Processes?: string[][] }>(
    "GET",
    `/containers/${encodeURIComponent(containerId)}/top?ps_args=${TOP_ARGS}`,
    undefined,
    { timeoutMs: 5000 },
  );
  const processes = parseTop(reply);
  const pid = processes[0]?.pid;
  if (!pid) return { processes, ports: null };

  // Every process in the container shares one network namespace.
  const tables = await Promise.all([
    readTable(pid, "tcp").then((t) => (t === null ? null : parseListening(t, "tcp"))),
    readTable(pid, "tcp6").then((t) => (t === null ? null : parseListening(t, "tcp"))),
    readTable(pid, "udp").then((t) => (t === null ? null : parseListening(t, "udp"))),
    readTable(pid, "udp6").then((t) => (t === null ? null : parseListening(t, "udp"))),
  ]);
  if (tables.every((t) => t === null)) return { processes, ports: null };
  return { processes, ports: [...new Set(tables.flatMap((t) => t ?? []))] };
}

// Samples a container's processes with `docker top` and its listening ports from the host's /proc. No exec.

import { readFile } from "fs/promises";
import { dockerRequest } from "@/lib/docker/client";
import { parseListening, parseTop, type TopProcess } from "./security";

const HOST_PROC = "/host-proc";
const TOP_ARGS = encodeURIComponent("-eo pid,comm,pcpu,rss");

export type ContainerProbe = {
  processes: TopProcess[];
  ports: string[] | null;
  /** Its socket table is the host's, so its ports can't be told apart from anyone else's. */
  hostNetwork: boolean;
  /** On another container's network namespace, so its socket table is the owner's. */
  sharedNetwork: boolean;
};

async function readTable(pid: number, file: string): Promise<string | null> {
  try {
    return await readFile(`${HOST_PROC}/${pid}/net/${file}`, "utf-8");
  } catch {
    return null;
  }
}

async function readPorts(pid: number): Promise<string[] | null> {
  // Every process in the container shares one network namespace.
  const tables = await Promise.all([
    readTable(pid, "tcp").then((t) => (t === null ? null : parseListening(t, "tcp"))),
    readTable(pid, "tcp6").then((t) => (t === null ? null : parseListening(t, "tcp"))),
    readTable(pid, "udp").then((t) => (t === null ? null : parseListening(t, "udp"))),
    readTable(pid, "udp6").then((t) => (t === null ? null : parseListening(t, "udp"))),
  ]);
  if (tables.every((t) => t === null)) return null;
  return [...new Set(tables.flatMap((t) => t ?? []))];
}

/** Ports are null when the host's /proc isn't mounted, the container can't be inspected or it's on the host's or another container's network. */
export async function probeContainer(containerId: string): Promise<ContainerProbe> {
  const id = encodeURIComponent(containerId);
  const [reply, inspect] = await Promise.all([
    dockerRequest<{ Titles?: string[]; Processes?: string[][] }>("GET", `/containers/${id}/top?ps_args=${TOP_ARGS}`, undefined, { timeoutMs: 5000 }),
    dockerRequest<{ State?: { Pid?: number }; HostConfig?: { NetworkMode?: string } }>("GET", `/containers/${id}/json`, undefined, { timeoutMs: 5000 }).catch(() => null),
  ]);
  const processes = parseTop(reply);
  const mode = inspect?.HostConfig?.NetworkMode;
  const hostNetwork = mode === "host";
  // Compose's `service:` arrives as `container:<id>`.
  const sharedNetwork = mode?.startsWith("container:") ?? false;
  const pid = inspect?.State?.Pid || processes[0]?.pid;
  if (!inspect || hostNetwork || sharedNetwork || !pid) return { processes, ports: null, hostNetwork, sharedNetwork };
  return { processes, ports: await readPorts(pid), hostNetwork, sharedNetwork };
}

export type AppPorts =
  /** Fold these into the allow-set. */
  | { action: "fold"; ports: string[] }
  /** On the host's or another container's network: drop the allow-set, which only ever held someone else's ports. */
  | { action: "forget" }
  /** Leave the allow-set alone. */
  | { action: "skip" };

/** What an app's probes say about its ports, given how many containers were probed. */
export function appPorts(probes: ContainerProbe[], probed: number): AppPorts {
  if (probes.some((p) => p.hostNetwork)) return { action: "forget" };
  // A namespace owner's probe covers the containers on its network.
  const own = probes.filter((p) => !p.sharedNetwork);
  if (probes.length === probed && own.length === 0) return { action: "forget" };
  // A container whose ports couldn't be read would look like it closed them all.
  if (probes.length < probed || own.some((p) => p.ports === null)) return { action: "skip" };
  return { action: "fold", ports: [...new Set(own.flatMap((p) => p.ports ?? []))] };
}

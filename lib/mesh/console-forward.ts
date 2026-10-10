// The WireGuard container's DNAT of tunnel traffic on the console port to the live console slot.

import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { execFileAsync } from "@/lib/utils/exec";
import { dockerEnv } from "@/lib/docker/docker-env";
import { logger } from "@/lib/logger";
import { isRunningInContainer } from "./env";
import { CONSOLE_PORT, CONSOLE_SERVICE, FRONTEND_MESH_IP, MESH_GATEWAY_IP, WG_CONTAINER } from "./constants";

const log = logger.child("mesh-forward");

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const PORT_RE = /^\d{1,5}$/;
const WG_CONF = "/config/wg_confs/wg0.conf";
const PROBE_TIMEOUT_MS = 2_000;

function assertForwardTarget(ip: string, port: string): void {
  if (!IPV4_RE.test(ip)) throw new Error(`Invalid console mesh IP: ${ip}`);
  if (!PORT_RE.test(port)) throw new Error(`Invalid console port: ${port}`);
}

/** wg0.conf PostUp/PostDown: masquerade out of wg0 and DNAT the console port to `ip`. */
export function forwardHooks(ip: string, port: string = CONSOLE_PORT): { postUp: string; postDown: string } {
  assertForwardTarget(ip, port);
  const rules = (op: "A" | "D") => [
    `iptables -t nat -${op} POSTROUTING -o wg0 -j MASQUERADE`,
    `iptables -t nat -${op} PREROUTING -i wg0 -p tcp --dport ${port} -j DNAT --to-destination ${ip}:${port}`,
    `iptables -${op} FORWARD -i wg0 -p tcp --dport ${port} -j ACCEPT`,
  ].join("; ");
  return { postUp: rules("A"), postDown: rules("D") };
}

export type ForwardRule = { line: string; ip: string };

/** Console DNAT rules in `iptables -t nat -S PREROUTING` output. */
export function parseForwardRules(output: string, port: string = CONSOLE_PORT): ForwardRule[] {
  const rules: ForwardRule[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    const words = line.split(/\s+/);
    if (words[0] !== "-A" || words[1] !== "PREROUTING") continue;
    if (!/(^|\s)-i wg0(\s|$)/.test(line) || !line.includes(`--dport ${port}`) || !line.includes("-j DNAT")) continue;
    const m = line.match(/--to-destination (\d{1,3}(?:\.\d{1,3}){3}):(\d+)/);
    if (m && m[2] === port) rules.push({ line, ip: m[1] });
  }
  return rules;
}

/** iptables argument lists that leave exactly one console DNAT rule, pointing at `ip`. */
export function planForward(output: string, ip: string, port: string = CONSOLE_PORT): string[][] {
  assertForwardTarget(ip, port);
  const rules = parseForwardRules(output, port);
  const plan: string[][] = [];
  if (!rules.some((r) => r.ip === ip)) {
    plan.push(["-t", "nat", "-A", "PREROUTING", "-i", "wg0", "-p", "tcp", "--dport", port, "-j", "DNAT", "--to-destination", `${ip}:${port}`]);
  }
  let keptOne = false;
  for (const rule of rules) {
    if (rule.ip === ip && !keptOne) {
      keptOne = true;
      continue;
    }
    plan.push(["-t", "nat", "-D", ...rule.line.split(/\s+/).slice(1)]);
  }
  return plan;
}

/** The address in `addresses` on the gateway's /24. */
export function meshIpFrom(addresses: string[], gateway: string = MESH_GATEWAY_IP): string | null {
  const prefix = gateway.split(".").slice(0, 3).join(".") + ".";
  return addresses.find((a) => IPV4_RE.test(a) && a.startsWith(prefix) && a !== gateway) ?? null;
}

/** This process's address on the mesh Docker network. */
export function ownMeshIp(): string | null {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => !!i && i.family === "IPv4")
    .map((i) => i.address);
  return meshIpFrom(addresses);
}

/** Mesh IP of the console container in a compose project, or null when it isn't running. */
export async function consoleMeshIp(projectName: string): Promise<string | null> {
  const { stdout: ids } = await execFileAsync("docker", [
    "ps", "-q",
    "--filter", `label=com.docker.compose.project=${projectName}`,
    "--filter", `label=com.docker.compose.service=${CONSOLE_SERVICE}`,
  ], { env: dockerEnv() });
  const id = ids.trim().split("\n")[0];
  if (!id) return null;
  const { stdout } = await execFileAsync("docker", [
    "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}", id,
  ], { env: dockerEnv() });
  return meshIpFrom(stdout.trim().split(/\s+/));
}

async function wgExec(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", ["exec", WG_CONTAINER, ...args], { env: dockerEnv() });
  return stdout;
}

/** The DNAT target persisted in wg0.conf; `exists` is false when the mesh isn't set up. */
async function readConfTarget(port: string): Promise<{ exists: boolean; ip: string | null }> {
  const out = await wgExec([
    "sh", "-c",
    `[ -f ${WG_CONF} ] || { echo missing; exit 0; }; grep -o -- '--to-destination [0-9.]*:${port}' ${WG_CONF} | head -1`,
  ]);
  if (out.trim() === "missing") return { exists: false, ip: null };
  const m = out.match(/--to-destination (\d{1,3}(?:\.\d{1,3}){3}):/);
  return { exists: true, ip: m ? m[1] : null };
}

/** Point the live rule and wg0.conf's PostUp/PostDown at `ip`. Returns the targets it replaced. */
export async function applyConsoleForward(ip: string, port: string = CONSOLE_PORT): Promise<string[]> {
  assertForwardTarget(ip, port);
  const current = await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]);
  const replaced = parseForwardRules(current, port).map((r) => r.ip).filter((p) => p !== ip);
  for (const args of planForward(current, ip, port)) await wgExec(["iptables", ...args]);
  // wg-quick runs PostUp on boot, so a WireGuard restart keeps the target.
  await wgExec([
    "sh", "-c",
    `[ ! -f ${WG_CONF} ] || sed -i -E 's/--to-destination [0-9.]+:${port}/--to-destination ${ip}:${port}/g' ${WG_CONF}`,
  ]);
  return replaced;
}

function tcpAnswers(ip: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: ip, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export type ForwardCheck =
  | { state: "ok"; target: string }
  | { state: "unconfigured" }
  | { state: "broken"; target: string | null; answers: boolean; reason: string };

/** Whether tunnel traffic on the console port reaches a console, without changing anything. */
export async function checkConsoleForward(port: string = CONSOLE_PORT): Promise<ForwardCheck> {
  let confTarget: string | null;
  let rules: ForwardRule[];
  try {
    const conf = await readConfTarget(port);
    if (!conf.exists) return { state: "unconfigured" };
    confTarget = conf.ip;
    rules = parseForwardRules(await wgExec(["iptables", "-t", "nat", "-S", "PREROUTING"]), port);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { state: "broken", target: null, answers: false, reason: `can't read ${WG_CONTAINER}: ${reason}` };
  }

  if (rules.length === 0) {
    return { state: "broken", target: null, answers: false, reason: `no DNAT rule for port ${port} in ${WG_CONTAINER}` };
  }
  const target = rules[0].ip;
  if (!(await tcpAnswers(target, Number(port)))) {
    return { state: "broken", target, answers: false, reason: `DNAT target ${target}:${port} doesn't answer` };
  }
  if (rules.length > 1) {
    return { state: "broken", target, answers: true, reason: `${rules.length} DNAT rules for port ${port}` };
  }
  if (confTarget !== target) {
    return { state: "broken", target, answers: true, reason: `wg0.conf forwards to ${confTarget ?? "nothing"}, the live rule to ${target}` };
  }
  return { state: "ok", target };
}

const globalForForward = globalThis as unknown as { __vardo_forward_reported?: string };

/** Log a broken forward once per distinct reason. */
function reportOnce(reason: string, line: string): void {
  if (globalForForward.__vardo_forward_reported === reason) return;
  globalForForward.__vardo_forward_reported = reason;
  log.error(line);
}

/** Repair a broken forward: keep a target that answers, else point it at this console. */
export async function reconcileConsoleForward(port: string = CONSOLE_PORT): Promise<ForwardCheck | null> {
  if (!isRunningInContainer()) return null;
  const check = await checkConsoleForward(port);
  if (check.state !== "broken") {
    globalForForward.__vardo_forward_reported = undefined;
    return check;
  }

  const next = (check.answers && check.target) || ownMeshIp();
  if (!next) {
    reportOnce(check.reason, `Mesh console forward is broken (${check.reason}); this console has no mesh address to point it at`);
    return check;
  }
  try {
    await applyConsoleForward(next, port);
  } catch (err) {
    reportOnce(check.reason, `Mesh console forward is broken (${check.reason}); repair failed: ${err instanceof Error ? err.message : err}`);
    return check;
  }
  log.warn(`Mesh console forward was broken (${check.reason}); now forwards to ${next}:${port}`);
  const after = await checkConsoleForward(port);
  if (after.state === "broken") reportOnce(after.reason, `Mesh console forward still broken after repair: ${after.reason}`);
  return after;
}


/** Point the forward at a slot's console after cutover. Best effort; never throws. */
export async function pointConsoleForwardAt(projectName: string, say: (line: string) => void): Promise<void> {
  try {
    const conf = await readConfTarget(CONSOLE_PORT).catch(() => ({ exists: false, ip: null }));
    if (!conf.exists) return;
    const ip = await consoleMeshIp(projectName);
    if (!ip) {
      say(`[deploy] Warning: no mesh address for ${projectName}'s console; the mesh forward will repair on the next heartbeat`);
      return;
    }
    const replaced = await applyConsoleForward(ip);
    if (replaced.length > 0) say(`[deploy] Mesh console forward: ${replaced.join(", ")} -> ${ip}`);
  } catch (err) {
    say(`[deploy] Warning: couldn't move the mesh console forward — ${err instanceof Error ? err.message : err}`);
  }
}

/** Target for a freshly written wg0.conf: this console, else the legacy fixed address. */
export function defaultForwardIp(): string {
  return (isRunningInContainer() && ownMeshIp()) || FRONTEND_MESH_IP;
}

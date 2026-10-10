import { HUB_IP } from "./ip-allocator";
import { WG_CONTAINER, FRONTEND_MESH_IP, CONSOLE_PORT } from "./constants";
import { execFile } from "node:child_process";
import { execFileAsync } from "@/lib/utils/exec";
import { redactError } from "@/lib/redact";
import { dockerEnv } from "@/lib/docker/docker-env";

// WireGuard base64 key: 44 chars, A-Z a-z 0-9 + / ending with =
const WG_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
// CIDR: x.x.x.x/n
const CIDR_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
// Endpoint: host:port or ip:port
const ENDPOINT_RE = /^[\w.\-]+:\d{1,5}$/;

export interface WgPeer {
  publicKey: string;
  endpoint?: string | null;
  allowedIps: string;
}

function validatePeer(peer: WgPeer): void {
  if (!WG_KEY_RE.test(peer.publicKey)) {
    throw new Error(`Invalid WireGuard public key format: ${peer.publicKey}`);
  }
  if (!CIDR_RE.test(peer.allowedIps)) {
    throw new Error(`Invalid AllowedIPs (must be CIDR): ${peer.allowedIps}`);
  }
  if (peer.endpoint && !ENDPOINT_RE.test(peer.endpoint)) {
    throw new Error(`Invalid endpoint format: ${peer.endpoint}`);
  }
}

/** Generate a WireGuard keypair inside the sidecar container. */
export async function generateKeypair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  // One exec, so the private key never appears in process args.
  const { stdout } = await execFileAsync("docker", [
    "exec",
    WG_CONTAINER,
    "sh",
    "-c",
    "key=$(wg genkey) && echo \"$key\" && echo \"$key\" | wg pubkey",
  ], { env: dockerEnv() });
  const [privateKey, publicKey] = stdout.trim().split("\n");
  return { privateKey, publicKey };
}

/** Build a wg0.conf string from the local keypair and peer list. */
export function buildWgConfig(
  privateKey: string,
  listenPort: number,
  address: string,
  peers: WgPeer[]
): string {
  if (!WG_KEY_RE.test(privateKey)) {
    throw new Error("Invalid WireGuard private key format");
  }

  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `ListenPort = ${listenPort}`,
    `Address = ${address}/24`,
    `PostUp = iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE; iptables -t nat -A PREROUTING -i wg0 -p tcp --dport ${CONSOLE_PORT} -j DNAT --to-destination ${FRONTEND_MESH_IP}:${CONSOLE_PORT}; iptables -A FORWARD -i wg0 -p tcp --dport ${CONSOLE_PORT} -j ACCEPT`,
    `PostDown = iptables -t nat -D POSTROUTING -o wg0 -j MASQUERADE; iptables -t nat -D PREROUTING -i wg0 -p tcp --dport ${CONSOLE_PORT} -j DNAT --to-destination ${FRONTEND_MESH_IP}:${CONSOLE_PORT}; iptables -D FORWARD -i wg0 -p tcp --dport ${CONSOLE_PORT} -j ACCEPT`,
    "",
  ];

  for (const peer of peers) {
    validatePeer(peer);
    lines.push("[Peer]");
    lines.push(`PublicKey = ${peer.publicKey}`);
    lines.push(`AllowedIPs = ${peer.allowedIps}`);
    if (peer.endpoint) {
      lines.push(`Endpoint = ${peer.endpoint}`);
    }
    lines.push("PersistentKeepalive = 25");
    lines.push("");
  }

  return lines.join("\n");
}

/** Write wg0.conf into the WireGuard container's config volume via stdin. */
export async function writeWgConfig(config: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "docker",
      ["exec", "-i", WG_CONTAINER, "sh", "-c", "mkdir -p /config/wg_confs && cat > /config/wg_confs/wg0.conf"],
      { env: dockerEnv() },
      (err) => (err ? reject(redactError(err)) : resolve())
    );
    child.stdin?.write(config);
    child.stdin?.end();
  });
}

/** Hot-reload WireGuard config without dropping existing tunnels. */
export async function syncConfig(): Promise<void> {
  // Busybox sh: no process substitution.
  await execFileAsync("docker", [
    "exec",
    WG_CONTAINER,
    "sh",
    "-c",
    "wg-quick strip wg0 | wg syncconf wg0 /dev/stdin",
  ], { env: dockerEnv() });
}

/**
 * Rebuild wg0.conf from every peer in the database and hot-reload WireGuard.
 * @param overrideAddress — local address overriding the existing config's.
 */
export async function rebuildAndSync(overrideAddress?: string): Promise<void> {
  // Dynamic imports to avoid circular dependencies
  const { db } = await import("@/lib/db");

  const { stdout: privKeyOut } = await execFileAsync("docker", [
    "exec", WG_CONTAINER, "sh", "-c",
    "cat /config/wg_confs/wg0.conf | grep PrivateKey | cut -d= -f2- | tr -d ' '",
  ], { env: dockerEnv() });
  const privateKey = privKeyOut.trim();
  if (!WG_KEY_RE.test(privateKey)) {
    throw new Error("Could not read WireGuard private key from config");
  }

  let address: string;
  if (overrideAddress) {
    address = overrideAddress;
  } else {
    const { stdout: addrOut } = await execFileAsync("docker", [
      "exec", WG_CONTAINER, "sh", "-c",
      "cat /config/wg_confs/wg0.conf | grep Address | cut -d= -f2- | tr -d ' ' | cut -d/ -f1",
    ], { env: dockerEnv() });
    address = addrOut.trim();
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) {
    throw new Error(`Invalid WireGuard address: ${address}`);
  }

  const allPeers = await db.query.meshPeers.findMany({
    columns: { publicKey: true, endpoint: true, allowedIps: true },
  });

  const wgPeers: WgPeer[] = allPeers.map((p) => ({
    publicKey: p.publicKey,
    endpoint: p.endpoint,
    allowedIps: p.allowedIps,
  }));

  const port = parseInt(process.env.WIREGUARD_PORT || "51820", 10);
  const config = buildWgConfig(privateKey, port, address, wgPeers);
  await writeWgConfig(config);

  if (overrideAddress) {
    // syncconf can't change the interface address, so restart.
    await execFileAsync("docker", [
      "exec", WG_CONTAINER, "sh", "-c", "wg-quick down wg0; wg-quick up wg0",
    ], { env: dockerEnv() });
  } else {
    await syncConfig();
  }
}

/** Check if the WireGuard container is running. */
export async function isWireguardRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      WG_CONTAINER,
    ], { env: dockerEnv() });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Bootstrap wg0 if it doesn't exist and return the hub's public key. */
export async function ensureHubConfig(hubIp: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec", WG_CONTAINER, "sh", "-c", "wg show wg0 public-key",
    ], { env: dockerEnv() });
    const key = stdout.trim();
    if (WG_KEY_RE.test(key)) return key;
  } catch {
    // Interface doesn't exist — bootstrap below
  }

  const { privateKey, publicKey } = await generateKeypair();
  const port = parseInt(process.env.WIREGUARD_PORT || "51820", 10);
  const config = buildWgConfig(privateKey, port, hubIp, []);
  await writeWgConfig(config);

  // The image deletes the default route when it boots without a config, so boot it with one.
  await execFileAsync("docker", ["restart", WG_CONTAINER], { env: dockerEnv() });
  await waitForInterface();

  return publicKey;
}

/** Wait for the container's init to bring wg0 up after a restart. */
export async function waitForInterface(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await execFileAsync("docker", [
        "exec", WG_CONTAINER, "wg", "show", "wg0", "public-key",
      ], { env: dockerEnv() });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`WireGuard interface wg0 didn't come up in ${WG_CONTAINER}`);
}

/** The hub's WireGuard address, or HUB_IP when the interface isn't reachable. */
export async function getHubAddress(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      WG_CONTAINER,
      "sh",
      "-c",
      "ip -4 addr show wg0 2>/dev/null | awk '/inet /{split($2,a,\"/\"); print a[1]; exit}'",
    ], { env: dockerEnv() });
    const ip = stdout.trim();
    if (ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return ip;
  } catch {
  }
  return HUB_IP;
}

/** Read the hub's WireGuard public key from the running container. */
export async function getHubPublicKey(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      WG_CONTAINER,
      "sh",
      "-c",
      "wg show wg0 public-key",
    ], { env: dockerEnv() });
    const key = stdout.trim();
    return WG_KEY_RE.test(key) ? key : null;
  } catch {
    return null;
  }
}

/** Get the current WireGuard interface status. */
export async function getWgStatus(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec",
      WG_CONTAINER,
      "wg",
      "show",
      "wg0",
    ], { env: dockerEnv() });
    return stdout.trim();
  } catch {
    return null;
  }
}

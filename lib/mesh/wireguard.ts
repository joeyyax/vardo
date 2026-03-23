import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WG_CONTAINER = "vardo-wireguard";

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
  // Single exec: generate private key and derive public key in one shell call.
  // No private key in process args — stays inside the container.
  const { stdout } = await execFileAsync("docker", [
    "exec",
    WG_CONTAINER,
    "sh",
    "-c",
    "key=$(wg genkey) && echo \"$key\" && echo \"$key\" | wg pubkey",
  ]);
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
      (err) => (err ? reject(err) : resolve())
    );
    child.stdin?.write(config);
    child.stdin?.end();
  });
}

/** Hot-reload WireGuard config without dropping existing tunnels. */
export async function syncConfig(): Promise<void> {
  // Pipe approach works in busybox sh (no bash process substitution needed)
  await execFileAsync("docker", [
    "exec",
    WG_CONTAINER,
    "sh",
    "-c",
    "wg-quick strip wg0 | wg syncconf wg0 /dev/stdin",
  ]);
}

/** Check if the WireGuard container is running. */
export async function isWireguardRunning(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      "-f",
      "{{.State.Running}}",
      WG_CONTAINER,
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
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
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

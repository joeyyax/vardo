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

  // Frontend container IP on the mesh Docker network (fixed in docker-compose.yml)
  const FRONTEND_MESH_IP = "10.88.0.3";

  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `ListenPort = ${listenPort}`,
    `Address = ${address}/24`,
    // Forward incoming mesh traffic to the frontend container
    `PostUp = iptables -t nat -A POSTROUTING -o wg0 -j MASQUERADE; iptables -t nat -A PREROUTING -i wg0 -p tcp --dport 3000 -j DNAT --to-destination ${FRONTEND_MESH_IP}:3000; iptables -A FORWARD -i wg0 -p tcp --dport 3000 -j ACCEPT`,
    `PostDown = iptables -t nat -D POSTROUTING -o wg0 -j MASQUERADE; iptables -t nat -D PREROUTING -i wg0 -p tcp --dport 3000 -j DNAT --to-destination ${FRONTEND_MESH_IP}:3000; iptables -D FORWARD -i wg0 -p tcp --dport 3000 -j ACCEPT`,
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

/**
 * Rebuild wg0.conf from all peers in the database and hot-reload WireGuard.
 * Call this after any peer registration or removal.
 *
 * @param overrideAddress — if provided, use this as the local WireGuard address
 *   instead of reading from the existing config. Used when the joiner's address
 *   needs to change from the bootstrap HUB_IP to the hub-assigned IP.
 */
export async function rebuildAndSync(overrideAddress?: string): Promise<void> {
  // Dynamic imports to avoid circular dependencies
  const { db } = await import("@/lib/db");
  const { meshPeers } = await import("@/lib/db/schema");

  // Read the current private key from the running interface
  const { stdout: privKeyOut } = await execFileAsync("docker", [
    "exec", WG_CONTAINER, "sh", "-c",
    "cat /config/wg_confs/wg0.conf | grep PrivateKey | cut -d= -f2- | tr -d ' '",
  ]);
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
    ]);
    address = addrOut.trim();
  }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address)) {
    throw new Error(`Invalid WireGuard address: ${address}`);
  }

  // Get all peers from the database
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
    // Address changed — syncconf can't update the interface address, need full restart
    await execFileAsync("docker", [
      "exec", WG_CONTAINER, "sh", "-c", "wg-quick down wg0; wg-quick up wg0",
    ]);
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
    ]);
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/**
 * Ensure the hub has a WireGuard config. If wg0 doesn't exist yet,
 * generate a keypair, write the initial config, and bring the interface up.
 * Returns the hub's public key.
 */
export async function ensureHubConfig(hubIp: string): Promise<string> {
  // Check if wg0 is already up
  try {
    const { stdout } = await execFileAsync("docker", [
      "exec", WG_CONTAINER, "sh", "-c", "wg show wg0 public-key",
    ]);
    const key = stdout.trim();
    if (WG_KEY_RE.test(key)) return key;
  } catch {
    // Interface doesn't exist — bootstrap below
  }

  // Generate keypair and write initial config (no peers yet)
  const { privateKey, publicKey } = await generateKeypair();
  const port = parseInt(process.env.WIREGUARD_PORT || "51820", 10);
  const config = buildWgConfig(privateKey, port, hubIp, []);
  await writeWgConfig(config);

  // Bring interface up
  await execFileAsync("docker", [
    "exec", WG_CONTAINER, "sh", "-c", "wg-quick up wg0",
  ]);

  return publicKey;
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
    ]);
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
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

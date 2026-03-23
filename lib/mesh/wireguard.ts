import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const WG_CONTAINER = "vardo-wireguard";

export interface WgPeer {
  publicKey: string;
  endpoint?: string | null;
  allowedIps: string;
}

/** Generate a WireGuard keypair inside the sidecar container. */
export async function generateKeypair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  const { stdout: privateKey } = await execAsync(
    `docker exec ${WG_CONTAINER} wg genkey`
  );
  const { stdout: publicKey } = await execAsync(
    `echo "${privateKey.trim()}" | docker exec -i ${WG_CONTAINER} wg pubkey`
  );
  return {
    privateKey: privateKey.trim(),
    publicKey: publicKey.trim(),
  };
}

/** Build a wg0.conf string from the local keypair and peer list. */
export function buildWgConfig(
  privateKey: string,
  listenPort: number,
  address: string,
  peers: WgPeer[]
): string {
  const lines = [
    "[Interface]",
    `PrivateKey = ${privateKey}`,
    `ListenPort = ${listenPort}`,
    `Address = ${address}/24`,
    "",
  ];

  for (const peer of peers) {
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

/** Write wg0.conf into the WireGuard container's config volume. */
export async function writeWgConfig(config: string): Promise<void> {
  const escaped = config.replace(/'/g, "'\\''");
  await execAsync(
    `docker exec ${WG_CONTAINER} sh -c 'mkdir -p /config/wg_confs && printf "%s" '"'"'${escaped}'"'"' > /config/wg_confs/wg0.conf'`
  );
}

/** Hot-reload WireGuard config without dropping existing tunnels. */
export async function syncConfig(): Promise<void> {
  await execAsync(
    `docker exec ${WG_CONTAINER} sh -c 'wg syncconf wg0 <(wg-quick strip wg0)'`
  );
}

/** Check if the WireGuard container is running. */
export async function isWireguardRunning(): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `docker inspect -f '{{.State.Running}}' ${WG_CONTAINER} 2>/dev/null`
    );
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

/** Get the current WireGuard interface status. */
export async function getWgStatus(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `docker exec ${WG_CONTAINER} wg show wg0`
    );
    return stdout.trim();
  } catch {
    return null;
  }
}

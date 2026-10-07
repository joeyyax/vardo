import { getInstanceConfig } from "@/lib/system-settings";

let cachedIp: string | null = null;

/** Server's public IPv4: instance config, then VARDO_SERVER_IP, then ipify. Cached per process. */
export async function getServerIP(): Promise<string> {
  if (cachedIp) return cachedIp;

  try {
    const config = await getInstanceConfig();
    if (config.serverIp) {
      cachedIp = config.serverIp;
      return cachedIp;
    }
  } catch {
    // DB may not be available yet.
  }

  if (process.env.VARDO_SERVER_IP) {
    cachedIp = process.env.VARDO_SERVER_IP;
    return cachedIp;
  }

  try {
    const res = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      cachedIp = (await res.text()).trim();
      return cachedIp;
    }
  } catch {
    // Auto-detect failed.
  }

  return "";
}

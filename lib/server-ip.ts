import { getInstanceConfig } from "@/lib/system-settings";

let cachedIp: string | null = null;

/**
 * Returns the server's public IPv4 address.
 *
 * Resolution order:
 * 1. Instance config `serverIp` from the database
 * 2. `VARDO_SERVER_IP` environment variable
 * 3. Auto-detect via https://api.ipify.org
 *
 * The result is cached for the lifetime of the process.
 */
export async function getServerIP(): Promise<string> {
  if (cachedIp) return cachedIp;

  // 1. Database config
  try {
    const config = await getInstanceConfig();
    if (config.serverIp) {
      cachedIp = config.serverIp;
      return cachedIp;
    }
  } catch {
    // DB may not be available yet — continue
  }

  // 2. Environment variable
  if (process.env.VARDO_SERVER_IP) {
    cachedIp = process.env.VARDO_SERVER_IP;
    return cachedIp;
  }

  // 3. Auto-detect
  try {
    const res = await fetch("https://api.ipify.org", {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      cachedIp = (await res.text()).trim();
      return cachedIp;
    }
  } catch {
    // auto-detect failed
  }

  return "";
}

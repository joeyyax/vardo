type ErrorEntry = { message: string; timestamp: number };

const recentErrors: ErrorEntry[] = [];
const MAX_ERRORS = 10;

/** Install global error listeners to buffer recent errors. Call early in widget init. */
export function installErrorCapture() {
  window.addEventListener("error", (e) => {
    recentErrors.push({ message: e.message || String(e.error), timestamp: Date.now() });
    if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
  });

  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason);
    recentErrors.push({ message: msg, timestamp: Date.now() });
    if (recentErrors.length > MAX_ERRORS) recentErrors.shift();
  });
}

/** Get the count of captured JS errors */
export function getErrorCount(): number {
  return recentErrors.length;
}

/** Collect all metadata at submit time */
export function collectMetadata(env?: string) {
  const ua = navigator.userAgent;
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    browser: detectBrowser(ua),
    browserVersion: detectBrowserVersion(ua),
    os: detectOS(ua),
    userAgent: ua,
    env: env || undefined,
    referrer: document.referrer || undefined,
    documentReadyState: document.readyState,
    cache: collectCacheInfo(),
    cookieNames: collectCookieNames(),
    connection: collectConnectionInfo(),
    memory: collectMemoryInfo(),
    recentErrors: recentErrors.length > 0 ? [...recentErrors] : undefined,
  };
}

export function detectBrowser(ua: string): string {
  if (ua.includes("Firefox")) return "Firefox";
  if (ua.includes("Edg/")) return "Edge";
  if (ua.includes("Chrome")) return "Chrome";
  if (ua.includes("Safari")) return "Safari";
  return "Unknown";
}

export function detectBrowserVersion(ua: string): string {
  // Try common patterns: Chrome/120.0.6099.130, Firefox/121.0, Edg/120.0, Safari/17.2
  const patterns = [
    /Edg\/([\d.]+)/,
    /Chrome\/([\d.]+)/,
    /Firefox\/([\d.]+)/,
    /Version\/([\d.]+).*Safari/,
  ];
  for (const pattern of patterns) {
    const match = ua.match(pattern);
    if (match) {
      const browser = detectBrowser(ua);
      return `${browser} ${match[1]}`;
    }
  }
  return detectBrowser(ua);
}

export function detectOS(ua: string): string {
  if (ua.includes("Mac")) return "macOS";
  if (ua.includes("Win")) return "Windows";
  if (ua.includes("Linux")) return "Linux";
  if (ua.includes("iPhone") || ua.includes("iPad")) return "iOS";
  if (ua.includes("Android")) return "Android";
  return "Unknown";
}

function collectCacheInfo() {
  try {
    const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entries.length === 0) return undefined;
    const nav = entries[0];
    return {
      transferSize: nav.transferSize ?? 0,
      navigationType: nav.type ?? "unknown",
      serviceWorkerControlled: !!navigator.serviceWorker?.controller,
    };
  } catch {
    return undefined;
  }
}

function collectCookieNames(): string[] | undefined {
  try {
    const cookie = document.cookie;
    if (!cookie) return undefined;
    return cookie.split(";").map((c) => c.trim().split("=")[0]).filter(Boolean);
  } catch {
    return undefined;
  }
}

function collectConnectionInfo() {
  try {
    const conn = (navigator as unknown as Record<string, unknown>).connection as
      | { type?: string; effectiveType?: string; downlink?: number; rtt?: number }
      | undefined;
    if (!conn) return undefined;
    return {
      type: conn.type,
      effectiveType: conn.effectiveType,
      downlink: conn.downlink,
      rtt: conn.rtt,
    };
  } catch {
    return undefined;
  }
}

function collectMemoryInfo() {
  try {
    const perf = performance as unknown as Record<string, unknown>;
    const memory = perf.memory as
      | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
      | undefined;
    if (!memory) return undefined;
    return {
      usedJSHeapSize: memory.usedJSHeapSize,
      totalJSHeapSize: memory.totalJSHeapSize,
      jsHeapSizeLimit: memory.jsHeapSizeLimit,
    };
  } catch {
    return undefined;
  }
}

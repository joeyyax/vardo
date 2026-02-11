import { registerModule } from "../registry";
import { getErrorCount, detectBrowser, detectBrowserVersion, detectOS } from "../metadata";
import type { WidgetModule, ModuleContext, HeartbeatPayload } from "../types";

const HEARTBEAT_DELAY_MS = 10_000; // Wait 10s for vitals to settle

class MetricsModule implements WidgetModule {
  id = "metrics";
  private ctx!: ModuleContext;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private observers: PerformanceObserver[] = [];
  private resourceErrorHandler: ((e: Event) => void) | null = null;

  // Counters
  private consoleErrorCount = 0;
  private consoleWarnCount = 0;
  private resourceFailureCount = 0;

  // Vitals
  private lcpValue: number | null = null;
  private clsValue = 0;
  private inpValue: number | null = null;
  private eventDurations: number[] = [];

  // Original console methods
  private origConsoleError: typeof console.error | null = null;
  private origConsoleWarn: typeof console.warn | null = null;

  init(ctx: ModuleContext) {
    this.ctx = ctx;
    this.installConsoleInterceptors();
    this.installResourceErrorListener();
    this.startPerformanceObservers();

    // Send heartbeat after delay
    this.timer = setTimeout(() => this.sendHeartbeat(), HEARTBEAT_DELAY_MS);
  }

  destroy() {
    if (this.timer) clearTimeout(this.timer);
    this.restoreConsole();
    this.disconnectObservers();
    this.removeResourceErrorListener();
  }

  private installConsoleInterceptors() {
    this.origConsoleError = console.error;
    this.origConsoleWarn = console.warn;

    const origError = this.origConsoleError;
    const origWarn = this.origConsoleWarn;
    const errorCounter = () => { this.consoleErrorCount++; };
    const warnCounter = () => { this.consoleWarnCount++; };

    console.error = function (...args: unknown[]) {
      errorCounter();
      origError.apply(console, args);
    };
    console.warn = function (...args: unknown[]) {
      warnCounter();
      origWarn.apply(console, args);
    };
  }

  private restoreConsole() {
    if (this.origConsoleError) console.error = this.origConsoleError;
    if (this.origConsoleWarn) console.warn = this.origConsoleWarn;
  }

  private installResourceErrorListener() {
    this.resourceErrorHandler = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName?.toLowerCase();
      if (tag === "script" || tag === "img" || tag === "link") {
        this.resourceFailureCount++;
      }
    };
    window.addEventListener("error", this.resourceErrorHandler, true);
  }

  private removeResourceErrorListener() {
    if (this.resourceErrorHandler) {
      window.removeEventListener("error", this.resourceErrorHandler, true);
    }
  }

  private startPerformanceObservers() {
    // LCP
    this.tryObserver("largest-contentful-paint", (entries) => {
      const last = entries[entries.length - 1];
      if (last) this.lcpValue = last.startTime;
    });

    // CLS
    this.tryObserver("layout-shift", (entries) => {
      for (const entry of entries) {
        const ls = entry as PerformanceEntry & { hadRecentInput?: boolean; value?: number };
        if (!ls.hadRecentInput && ls.value) {
          this.clsValue += ls.value;
        }
      }
    });

    // INP (event timing)
    this.tryObserver("event", (entries) => {
      for (const entry of entries) {
        this.eventDurations.push(entry.duration);
      }
    }, { durationThreshold: 16 });
  }

  private tryObserver(
    type: string,
    callback: (entries: PerformanceEntryList) => void,
    extraOptions?: Record<string, unknown>
  ) {
    try {
      const obs = new PerformanceObserver((list) => callback(list.getEntries()));
      obs.observe({ type, buffered: true, ...extraOptions } as PerformanceObserverInit);
      this.observers.push(obs);
    } catch {
      // Observer type not supported in this browser
    }
  }

  private disconnectObservers() {
    for (const obs of this.observers) {
      obs.disconnect();
    }
    this.observers = [];
  }

  private computeInp(): number | null {
    if (this.eventDurations.length === 0) return null;
    // p98 of event durations
    const sorted = [...this.eventDurations].sort((a, b) => a - b);
    const idx = Math.min(
      Math.ceil(sorted.length * 0.98) - 1,
      sorted.length - 1
    );
    return sorted[idx];
  }

  private collectNavigation(): HeartbeatPayload["metrics"]["navigation"] {
    try {
      const entries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      if (entries.length === 0) return null;
      const nav = entries[0];
      return {
        ttfb: nav.responseStart - nav.requestStart,
        domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
        load: nav.loadEventEnd - nav.startTime,
        transferSize: nav.transferSize ?? 0,
        encodedBodySize: nav.encodedBodySize ?? 0,
      };
    } catch {
      return null;
    }
  }

  private collectConnection(): HeartbeatPayload["metrics"]["connection"] {
    try {
      const conn = (navigator as unknown as Record<string, unknown>).connection as
        | { effectiveType?: string; downlink?: number; rtt?: number }
        | undefined;
      if (!conn) return null;
      return {
        effectiveType: conn.effectiveType,
        downlink: conn.downlink,
        rtt: conn.rtt,
      };
    } catch {
      return null;
    }
  }

  private collectMemory(): HeartbeatPayload["metrics"]["memory"] {
    try {
      const perf = performance as unknown as Record<string, unknown>;
      const memory = perf.memory as
        | { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
        | undefined;
      if (!memory) return null;
      return {
        usedJSHeapSize: memory.usedJSHeapSize,
        totalJSHeapSize: memory.totalJSHeapSize,
        jsHeapSizeLimit: memory.jsHeapSizeLimit,
      };
    } catch {
      return null;
    }
  }

  private sendHeartbeat() {
    const auth = this.ctx.auth;
    if (!auth.scopeClientId || !auth.organizationId) return;

    const ua = navigator.userAgent;
    const payload: HeartbeatPayload = {
      scopeClientId: auth.scopeClientId,
      organizationId: auth.organizationId,
      pageUrl: window.location.href,
      metrics: {
        navigation: this.collectNavigation(),
        vitals: {
          lcp: this.lcpValue,
          cls: this.clsValue > 0 ? Math.round(this.clsValue * 1000) / 1000 : null,
          inp: this.computeInp(),
        },
        errors: {
          jsErrors: getErrorCount(),
          consoleErrors: this.consoleErrorCount,
          consoleWarns: this.consoleWarnCount,
          resourceFailures: this.resourceFailureCount,
        },
        connection: this.collectConnection(),
        memory: this.collectMemory(),
      },
      metadata: {
        browser: detectBrowser(ua),
        browserVersion: detectBrowserVersion(ua),
        os: detectOS(ua),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        env: this.ctx.config.env,
      },
      timestamp: Date.now(),
    };

    this.ctx.bridge.sendHeartbeat(payload);
  }
}

registerModule(new MetricsModule());

import { BridgeClient } from "./bridge-client";
import { installErrorCapture } from "./metadata";
import { WIDGET_CSS } from "./styles";
import { getModules } from "./registry";
import type { WidgetConfig, AuthResponse, WidgetModule, ModuleContext } from "./types";

// Import modules — they self-register via registerModule()
import "./modules/bug-report";
import "./modules/metrics";

// --- Disabled-client cache ---

const CACHE_KEY_PREFIX = "scope-disabled-";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function isClientDisabled(token: string): boolean {
  try {
    const raw = localStorage.getItem(`${CACHE_KEY_PREFIX}${token}`);
    if (!raw) return false;
    const expiry = parseInt(raw, 10);
    if (Date.now() < expiry) return true;
    localStorage.removeItem(`${CACHE_KEY_PREFIX}${token}`);
    return false;
  } catch {
    return false;
  }
}

function markClientDisabled(token: string) {
  try {
    localStorage.setItem(
      `${CACHE_KEY_PREFIX}${token}`,
      String(Date.now() + CACHE_TTL_MS)
    );
  } catch {
    // localStorage not available
  }
}

// --- Core initialization ---

class ScopeCore {
  private config: WidgetConfig;
  private bridge: BridgeClient;
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private activeModules: WidgetModule[] = [];

  constructor(config: WidgetConfig) {
    this.config = config;
    this.bridge = new BridgeClient(config.apiUrl, config.token);
    this.init();
  }

  private async init() {
    const auth = await this.bridge.waitForAuth();

    if (!auth.authenticated) {
      markClientDisabled(this.config.token);
      this.bridge.destroy();
      return;
    }

    this.createHost();
    this.initModules(auth);
  }

  private createHost() {
    this.host = document.createElement("div");
    this.host.id = "scope-widget";
    this.shadow = this.host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = WIDGET_CSS;
    this.shadow.appendChild(style);

    document.body.appendChild(this.host);
  }

  private initModules(auth: AuthResponse) {
    const ctx: ModuleContext = {
      config: this.config,
      auth,
      bridge: this.bridge,
      host: this.host,
      shadow: this.shadow,
    };

    for (const mod of getModules()) {
      try {
        mod.init(ctx);
        this.activeModules.push(mod);
      } catch (err) {
        console.warn(`[Scope] Module "${mod.id}" failed to init:`, err);
      }
    }
  }

  destroy() {
    for (const mod of this.activeModules) {
      try {
        mod.destroy?.();
      } catch {
        // ignore cleanup errors
      }
    }
    this.activeModules = [];
    this.bridge.destroy();
    this.host?.remove();
  }
}

// --- Auto-init from script tag ---

(function () {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  // Support both data-key (new) and data-project (backward compat)
  const token = script.getAttribute("data-key");
  const legacyProjectId = script.getAttribute("data-project");

  if (!token && !legacyProjectId) {
    console.warn("[Scope] Missing data-key attribute on script tag");
    return;
  }

  const identifier = token || legacyProjectId!;

  // Skip if this client/project was recently disabled
  if (isClientDisabled(identifier)) return;

  // Install error capture early
  installErrorCapture();

  // Derive API URL from script src
  let apiUrl: string;
  try {
    const url = new URL(script.src);
    apiUrl = url.origin;
  } catch {
    console.warn("[Scope] Could not determine API URL from script src");
    return;
  }

  const env = script.getAttribute("data-env") || undefined;

  new ScopeCore({ token: identifier, apiUrl, env });
})();

// Expose for manual instantiation
(window as unknown as Record<string, unknown>).ScopeWidget = ScopeCore;

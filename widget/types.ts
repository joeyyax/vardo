import type { BridgeClient } from "./bridge-client";

export interface WidgetConfig {
  token: string;
  env?: string;
  apiUrl: string;
}

export interface AuthResponse {
  type: "scope-auth";
  authenticated: boolean;
  user?: { id: string; name: string; email: string };
  scopeClientId?: string;
  organizationId?: string;
  clientId?: string;
  defaultProjectId?: string;
  publicAccess?: boolean;
  reports?: BugReport[];
}

export interface ModuleContext {
  config: WidgetConfig;
  auth: AuthResponse;
  bridge: BridgeClient;
  host: HTMLElement;
  shadow: ShadowRoot;
}

export interface WidgetModule {
  id: string;
  init(ctx: ModuleContext): void;
  destroy?(): void;
}

export interface ScreenshotCapture {
  dataUrl: string;
  selectionRect: { x: number; y: number; width: number; height: number };
  expandedRect: { x: number; y: number; width: number; height: number };
  scrollOffset: { x: number; y: number };
}

export interface BugReport {
  id: string;
  description: string;
  status: string;
  pageUrl?: string;
  createdAt: string;
  updatedAt?: string;
  priority?: string | null;
  assignee?: { id: string; name: string; email: string };
  commentCount?: number;
  reporter?: { id: string; name: string; email: string };
  project?: { id: string; name: string };
  metadata?: Record<string, unknown>;
}

export interface SubmitPayload {
  organizationId: string;
  projectId: string;
  clientId: string;
  scopeClientId: string;
  description: string;
  pageUrl: string;
  priority?: string | null;
  metadata: {
    viewport: { width: number; height: number };
    browser: string;
    browserVersion: string;
    os: string;
    userAgent: string;
    env?: string;
    referrer?: string;
    cache?: {
      transferSize: number;
      navigationType: string;
      serviceWorkerControlled: boolean;
    };
    cookieNames?: string[];
    connection?: {
      type?: string;
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
    };
    documentReadyState: string;
    recentErrors?: Array<{ message: string; timestamp: number }>;
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    };
  };
  screenshots: ScreenshotCapture[];
}

export interface SubmitResult {
  type: "scope-submit-result";
  success: boolean;
  report?: BugReport;
  uploadUrl?: string;
  error?: string;
}

export interface HeartbeatPayload {
  scopeClientId: string;
  organizationId: string;
  pageUrl: string;
  metrics: {
    navigation: {
      ttfb: number;
      domContentLoaded: number;
      load: number;
      transferSize: number;
      encodedBodySize: number;
    } | null;
    vitals: {
      lcp: number | null;
      cls: number | null;
      inp: number | null;
    };
    errors: {
      jsErrors: number;
      consoleErrors: number;
      consoleWarns: number;
      resourceFailures: number;
    };
    connection: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
    } | null;
    memory: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
      jsHeapSizeLimit: number;
    } | null;
  };
  metadata: {
    browser: string;
    browserVersion: string;
    os: string;
    viewport: { width: number; height: number };
    env?: string;
  };
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Lifecycle hook types
// ---------------------------------------------------------------------------

/** Result of executing a single hook. */
export type HookResult = {
  hookId: string;
  hookName: string;
  allowed: boolean;
  reason?: string;
  durationMs: number;
};

/** Result of executing all hooks for an event. */
export type HookExecutionResult = {
  allowed: boolean;
  results: HookResult[];
  /** If blocked, which hook blocked it and why */
  blockedBy?: { hookId: string; hookName: string; reason: string };
};

/** Hook types determine how they're executed. */
export type HookType = "webhook" | "script" | "internal";

/** What happens when a hook fails or times out. */
export type FailMode = "fail" | "warn" | "ignore";

/** Webhook hook config. */
export type WebhookHookConfig = {
  url: string;
  secret?: string;
  timeoutMs?: number;
};

/** Script hook config (runs on host). */
export type ScriptHookConfig = {
  command: string;
  timeoutMs?: number;
};

/** Internal hook config (calls a registered handler function). */
export type InternalHookConfig = {
  handler: string; // registered handler name
};

export type HookConfig = WebhookHookConfig | ScriptHookConfig | InternalHookConfig;

/** The context passed to hooks — what they can inspect to make decisions. */
export type HookContext = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Hook executor — runs hooks in priority order
//
// For before.* hooks: runs sequentially, blocks on each.
//   - "fail" mode: stops pipeline on failure
//   - "warn" mode: logs warning, continues
//   - "ignore" mode: silent, continues
//
// For after.* hooks: fires as stream events (handled by consumers, never blocks).
// This module only handles before.* (filter) hooks.
// ---------------------------------------------------------------------------

import { createHmac } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getHooksForEvent, getInternalHandler } from "./registry";
import { addDeployLog } from "@/lib/stream/producer";
import type {
  HookResult,
  HookExecutionResult,
  HookContext,
  FailMode,
  WebhookHookConfig,
  ScriptHookConfig,
} from "./types";
import { logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);
const log = logger.child("hooks");

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute all registered hooks for a before.* event.
 *
 * Runs hooks in priority order. Each hook's failMode determines what
 * happens on failure. Returns the aggregate result — whether the
 * action should proceed.
 *
 * Optionally writes hook status to a deploy stream for UI visibility.
 */
export async function executeHooks(
  event: string,
  context: HookContext,
  opts?: {
    organizationId?: string;
    appId?: string;
    /** If provided, hook status is written to this deploy's stream */
    deployId?: string;
  },
): Promise<HookExecutionResult> {
  const hooks = await getHooksForEvent(event, {
    organizationId: opts?.organizationId,
    appId: opts?.appId,
  });

  if (hooks.length === 0) {
    return { allowed: true, results: [] };
  }

  const results: HookResult[] = [];

  for (const hook of hooks) {
    // Log to deploy stream if available
    if (opts?.deployId) {
      await addDeployLog(opts.deployId, {
        line: `[hook] Running: ${hook.name}`,
        stage: "hook",
        status: "running",
      }).catch(() => {});
    }

    const start = Date.now();
    let result: HookResult;

    try {
      const response = await executeOne(hook, context);
      result = {
        hookId: hook.id,
        hookName: hook.name,
        allowed: response.allowed,
        reason: response.reason,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result = {
        hookId: hook.id,
        hookName: hook.name,
        allowed: false,
        reason: `Hook error: ${errorMsg}`,
        durationMs: Date.now() - start,
      };
    }

    results.push(result);

    // Log result to deploy stream
    if (opts?.deployId) {
      const status = result.allowed ? "passed" : "blocked";
      await addDeployLog(opts.deployId, {
        line: `[hook] ${hook.name}: ${status}${result.reason ? ` — ${result.reason}` : ""} (${result.durationMs}ms)`,
        stage: "hook",
        status: result.allowed ? "running" : "failed",
      }).catch(() => {});
    }

    // Apply fail mode
    if (!result.allowed) {
      const failMode = hook.failMode as FailMode;

      if (failMode === "fail") {
        log.warn(`Hook "${hook.name}" blocked ${event}: ${result.reason}`);
        return {
          allowed: false,
          results,
          blockedBy: {
            hookId: hook.id,
            hookName: hook.name,
            reason: result.reason || "Hook rejected the action",
          },
        };
      }

      if (failMode === "warn") {
        log.warn(`Hook "${hook.name}" failed (warn mode, continuing): ${result.reason}`);
      }
      // "ignore" mode: silently continue
    }
  }

  return { allowed: true, results };
}

// ---------------------------------------------------------------------------
// Hook type executors
// ---------------------------------------------------------------------------

async function executeOne(
  hook: { type: string; config: Record<string, unknown>; name: string },
  context: HookContext,
): Promise<{ allowed: boolean; reason?: string }> {
  switch (hook.type) {
    case "webhook":
      return executeWebhook(hook.config as unknown as WebhookHookConfig, context);
    case "script":
      return executeScript(hook.config as unknown as ScriptHookConfig, context);
    case "internal":
      return executeInternal(hook.config.handler as string, context);
    default:
      return { allowed: false, reason: `Unknown hook type: ${hook.type}` };
  }
}

/** Execute a webhook hook — POST to URL, expect { allow: true/false, reason? }. */
async function executeWebhook(
  config: WebhookHookConfig,
  context: HookContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(context);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (config.secret) {
    const signature = createHmac("sha256", config.secret)
      .update(payload)
      .digest("hex");
    headers["X-Hook-Signature-256"] = `sha256=${signature}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers,
      body: payload,
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        allowed: false,
        reason: `Webhook returned ${response.status}`,
      };
    }

    const body = await response.json() as { allow?: boolean; reason?: string };
    return {
      allowed: body.allow !== false, // Default to allowed if field missing
      reason: body.reason,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { allowed: false, reason: `Webhook timed out after ${timeout}ms` };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Execute a script hook — run command, exit 0 = allowed. */
async function executeScript(
  config: ScriptHookConfig,
  context: HookContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const timeout = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const { stdout } = await execFileAsync("bash", ["-c", config.command], {
      timeout,
      env: {
        ...process.env,
        HOOK_CONTEXT: JSON.stringify(context),
      },
    });
    return { allowed: true, reason: stdout.trim() || undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { allowed: false, reason: msg };
  }
}

/** Execute an internal hook — call a registered handler function. */
async function executeInternal(
  handlerName: string,
  context: HookContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const handler = getInternalHandler(handlerName);
  if (!handler) {
    return { allowed: false, reason: `Internal handler "${handlerName}" not found` };
  }
  return handler(context);
}

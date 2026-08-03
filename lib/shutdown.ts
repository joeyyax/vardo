import { logger } from "./logger";

const log = logger.child("shutdown");

/** How long in-flight work gets after SIGTERM before the process exits anyway. */
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5000);

type Closer = () => void;

type ShutdownState = {
  closers: Set<Closer>;
  shuttingDown: boolean;
  installed: boolean;
};

// Next compiles instrumentation and route handlers into separate bundles, so
// module-level state is duplicated. The registry has to live on globalThis.
const globalForShutdown = globalThis as unknown as { __vardo_shutdown?: ShutdownState };

const state: ShutdownState = (globalForShutdown.__vardo_shutdown ??= {
  closers: new Set(),
  shuttingDown: false,
  installed: false,
});

/**
 * Register a closer to run when shutdown starts.
 * Returns an unregister function — call it when the resource closes normally.
 */
export function closeOnShutdown(closer: Closer): () => void {
  installShutdownHandlers();
  if (state.shuttingDown) {
    runCloser(closer);
    return () => {};
  }
  state.closers.add(closer);
  return () => {
    state.closers.delete(closer);
  };
}

/** True once SIGTERM/SIGINT has been received. */
export function isShuttingDown(): boolean {
  return state.shuttingDown;
}

function runCloser(closer: Closer) {
  // One bad closer must not stop the rest of the drain.
  try {
    closer();
  } catch {
    /* ignored */
  }
}

function shutdown(signal: string) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  log.info(`${signal} received, draining (${DRAIN_MS}ms max)`);

  // SSE streams never end on their own — cut them instead of holding the
  // listener open until the deadline.
  const pending = state.closers.size;
  for (const closer of [...state.closers]) runCloser(closer);
  state.closers.clear();
  if (pending > 0) log.info(`Closed ${pending} stream(s)`);

  // Backstop. Next closes the listener and exits 0 once in-flight requests finish.
  const deadline = setTimeout(() => {
    log.warn("Drain deadline reached, exiting");
    process.exit(0);
  }, DRAIN_MS);
  deadline.unref();
}

/** Install SIGTERM/SIGINT handlers. Safe to call more than once. */
export function installShutdownHandlers() {
  if (state.installed) return;
  state.installed = true;
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

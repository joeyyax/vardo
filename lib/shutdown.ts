import { logger } from "./logger";

const log = logger.child("shutdown");

/** How long in-flight work gets after SIGTERM before the process exits anyway. */
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS ?? 5000);

type Closer = () => void;

type ShutdownState = {
  closers: Set<Closer>;
  shuttingDown: boolean;
  installed: boolean;
  signal?: string;
};

// Must live on globalThis; Next duplicates module state across bundles.
const globalForShutdown = globalThis as unknown as { __vardo_shutdown?: ShutdownState };

const state: ShutdownState = (globalForShutdown.__vardo_shutdown ??= {
  closers: new Set(),
  shuttingDown: false,
  installed: false,
});

/** Register a closer to run on shutdown. Returns an unregister function. */
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

/** The signal that started the shutdown, if one has. */
export function shutdownSignal(): string | undefined {
  return state.signal;
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
  state.signal = signal;

  log.info(`${signal} received, draining (${DRAIN_MS}ms max)`);

  const pending = state.closers.size;
  for (const closer of [...state.closers]) runCloser(closer);
  state.closers.clear();
  if (pending > 0) log.info(`Closed ${pending} registered resource(s)`);

  // Backstop if in-flight requests don't finish.
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

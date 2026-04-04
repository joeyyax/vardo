// ---------------------------------------------------------------------------
// Redis Streams — unified event infrastructure
//
// Replaces both lib/events.ts (Redis pub/sub) and lib/bus/ (typed bus)
// with Redis Streams for persistent, replayable, consumer-group-based
// event delivery.
// ---------------------------------------------------------------------------

// Producer
export { addEvent, addDeployLog, addToast, addInstallEvent } from "./producer";

// Consumer
export { readStream, consumeGroup } from "./consumer";

// Key naming
export { eventStream, deployStream, toastStream, installStream } from "./keys";

// Types
export type {
  StreamEntry,
  ToastEvent,
  ToastTier,
  ReadStreamOptions,
  ConsumeGroupOptions,
} from "./types";

// Config
export { getStreamMaxLen, resetStreamConfig } from "./config";

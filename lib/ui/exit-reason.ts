import type { ExitReason, ExitReasonKind } from "@/lib/docker/exit-reason";

/** Categorical name. */
export function exitReasonLabel(kind: ExitReasonKind): string {
  switch (kind) {
    case "oom-host":
      return "Out of memory";
    case "oom-limit":
      return "Memory limit";
    case "signal":
      return "Stopped";
    case "failed":
      return "Exited";
  }
}

/** What happened, as a sentence. */
export function exitReasonDetail(reason: ExitReason): string {
  switch (reason.kind) {
    case "oom-host":
      return `The host ran out of memory and the kernel killed ${reason.containerName}, which has no memory limit of its own`;
    case "oom-limit":
      return `${reason.containerName} was killed at its own memory limit`;
    case "signal":
      return `${reason.containerName} took ${reason.signal} and exited ${reason.exitCode}`;
    case "failed":
      return `${reason.containerName} exited with code ${reason.exitCode}`;
  }
}

/** Short form for list rows. */
export function exitReasonShort(reason: ExitReason): string {
  switch (reason.kind) {
    case "oom-host":
      return "host out of memory";
    case "oom-limit":
      return "hit its memory limit";
    case "signal":
      return `${reason.signal} (${reason.exitCode})`;
    case "failed":
      return `exit ${reason.exitCode}`;
  }
}

/** Error for OOM kills, muted otherwise. */
export function exitReasonTone(kind: ExitReasonKind): "error" | "muted" {
  return kind === "oom-host" || kind === "oom-limit" ? "error" : "muted";
}

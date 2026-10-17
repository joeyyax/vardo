// Where a deploy's build ran, what it sent and made, and how its images came back, persisted to the deployment row.

/** `here`: built on this server. `target`: built on the target. `fallback`: the target failed and the build ran here. */
export type BuildOutcome = "here" | "target" | "fallback";

/** How the images came back. `mixed` when a deploy's images came back different ways. */
export type ImageTransfer = "registry" | "ssh" | "registry_skipped" | "mixed";

export type BuildPlacementColumns = {
  buildTargetId: string | null;
  buildTargetName: string | null;
  buildOutcome: BuildOutcome | null;
  buildFallbackReason: string | null;
  imageTransfer: ImageTransfer | null;
  imageTransferMs: number | null;
  imageTransferBytes: number | null;
  buildContextBytes: number | null;
  imageBytes: number | null;
  buildPeakBytes: number | null;
};

export const NO_PLACEMENT: BuildPlacementColumns = {
  buildTargetId: null,
  buildTargetName: null,
  buildOutcome: null,
  buildFallbackReason: null,
  imageTransfer: null,
  imageTransferMs: null,
  imageTransferBytes: null,
  buildContextBytes: null,
  imageBytes: null,
  buildPeakBytes: null,
};

type Target = { id: string; name: string };

/** One image brought back: the way, its time and, over SSH, the bytes sent. */
export type Transfer = { via: Exclude<ImageTransfer, "mixed">; ms: number; bytes?: number };

const sum = (a: number | null, b: number | null | undefined) => (b == null ? a : (a ?? 0) + b);

/** Collects a deploy's build placement. A deploy records its first target; transfers and sizes sum. */
export function createBuildPlacement() {
  let target: Target | null = null;
  let outcome: BuildOutcome | null = null;
  let reason: string | null = null;
  let transfers: Transfer[] = [];
  let contextBytes: number | null = null;
  let imageBytes: number | null = null;
  let peakBytes: number | null = null;

  return {
    /** A build started on this server. */
    here() {
      outcome ??= "here";
    },
    /** A build started on `on`. */
    started(on: Target) {
      if (target && target.id !== on.id) return;
      if (outcome === "here") return;
      target = { id: on.id, name: on.name };
      outcome = "target";
      reason = null;
    },
    /** One image came back from the target. */
    transferred(t: Transfer) {
      if (outcome === "target") transfers.push(t);
    },
    /** `on` couldn't build, so the build reruns here. */
    fellBack(on: Target, why: string) {
      if (target && target.id !== on.id) return;
      target = { id: on.id, name: on.name };
      outcome = "fallback";
      reason = why;
      transfers = [];
    },
    /** A finished build's context sent and image size, where known. */
    built(sizes: { contextBytes?: number | null; imageBytes?: number | null }) {
      contextBytes = sum(contextBytes, sizes.contextBytes);
      imageBytes = sum(imageBytes, sizes.imageBytes);
    },
    /** The builder's memory peak for a build that ran alone on it. */
    peak(bytes: number) {
      peakBytes = Math.max(peakBytes ?? 0, bytes);
    },
    columns(): BuildPlacementColumns {
      if (!outcome) return NO_PLACEMENT;
      const ways = new Set(transfers.map((t) => t.via));
      const sent = transfers.filter((t) => t.bytes != null);
      return {
        buildTargetId: target?.id ?? null,
        buildTargetName: target?.name ?? null,
        buildOutcome: outcome,
        buildFallbackReason: reason,
        imageTransfer: ways.size === 0 ? null : ways.size === 1 ? [...ways][0] : "mixed",
        imageTransferMs: transfers.length ? transfers.reduce((n, t) => n + Math.round(t.ms), 0) : null,
        imageTransferBytes: sent.length ? sent.reduce((n, t) => n + (t.bytes ?? 0), 0) : null,
        buildContextBytes: contextBytes,
        imageBytes,
        buildPeakBytes: outcome === "target" ? null : peakBytes,
      };
    },
  };
}

export type BuildPlacementRecorder = ReturnType<typeof createBuildPlacement>;

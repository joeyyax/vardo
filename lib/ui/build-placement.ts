import { formatBytes, formatDuration } from "@/lib/metrics/format";
import type { BuildPlacementColumns } from "@/lib/docker/build-placement";
import type { BuildStats } from "@/lib/docker/build-placement-stats";

export type PlacementFields = Partial<Omit<BuildPlacementColumns, "buildTargetId">>;

/** What a deploy built elsewhere shows: a short label and how the image came back. Null for a local build. */
export type BuiltOn = { kind: "target" | "fallback"; target: string; label: string; detail: string | null };

function transferDetail(d: PlacementFields): string | null {
  const took = d.imageTransferMs != null ? ` in ${formatDuration(d.imageTransferMs, { precise: true })}` : "";
  const size = d.imageTransferBytes != null ? ` (${formatBytes(d.imageTransferBytes)})` : "";
  switch (d.imageTransfer) {
    case "registry":
      return `Pulled from the build registry${took}`;
    case "ssh":
      return `Copied over SSH${took}${size}`;
    case "session":
      return `Streamed back from the builder${took}${size}`;
    case "registry_skipped":
      return `Copied directly${took}${size}, skipping the registry for a large layer`;
    case "mixed":
      return `Came back through the build registry and directly${took}${size}`;
    default:
      return null;
  }
}

export function builtOn(d: PlacementFields): BuiltOn | null {
  const target = d.buildTargetName;
  if (!target || !d.buildOutcome) return null;
  if (d.buildOutcome === "fallback") {
    return {
      kind: "fallback",
      target,
      label: `Built here; ${target} was unavailable`,
      detail: d.buildFallbackReason ? `${target} couldn't build: ${d.buildFallbackReason}` : null,
    };
  }
  return { kind: "target", target, label: `Built on ${target}`, detail: transferDetail(d) };
}

const present = (parts: (string | false | null)[]) => parts.filter((p): p is string => Boolean(p));

/** The Build targets card's numbers for this server or a target: counts, then medians. Null without builds. */
export function buildStatsParts(stats: BuildStats | null | undefined, where: "here" | "target"): { counts: string[]; medians: string[] } | null {
  if (!stats || stats.builds === 0) return null;
  const counts = present([
    `${stats.builds} ${stats.builds === 1 ? "build" : "builds"}`,
    stats.fallbacks > 0 && (where === "here" ? `${stats.fallbacks} after a target was unavailable` : `${stats.fallbacks} fell back here`),
    stats.registry > 0 && `${stats.registry} via registry`,
    stats.ssh > 0 && `${stats.ssh} copied directly${stats.skipped > 0 ? ` (${stats.skipped} skipped the registry)` : ""}`,
    stats.mixed > 0 && `${stats.mixed} both ways`,
  ]);
  const ms = (n: number) => formatDuration(n, { precise: true });
  const medians = present([
    stats.medianBuildMs != null && `build ${ms(stats.medianBuildMs)}`,
    stats.medianContextBytes != null && `context ${formatBytes(stats.medianContextBytes)}`,
    stats.medianImageBytes != null && `image ${formatBytes(stats.medianImageBytes)}`,
    stats.medianPeakBytes != null && `peak memory ${formatBytes(stats.medianPeakBytes)}`,
    stats.medianTransferMs != null && `bring-back ${ms(stats.medianTransferMs)}`,
    stats.medianTransferBytes != null && `${formatBytes(stats.medianTransferBytes)} copied`,
  ]);
  return { counts, medians };
}

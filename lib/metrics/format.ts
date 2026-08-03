export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

// Memory limit > 1TB is effectively "unlimited" (Docker reports host RAM or sentinel)
export function formatMemLimit(bytes: number): string {
  if (bytes === 0 || bytes > 1099511627776) return "No limit";
  return formatBytes(bytes);
}

export function formatBytesShort(bytes: number): string {
  if (bytes === 0) return "0";
  const k = 1024;
  const sizes = ["B", "K", "M", "G", "T"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const val = bytes / Math.pow(k, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)}${sizes[i]}`;
}

export function formatBytesRate(bytes: number): string {
  return `${formatBytes(bytes)}/s`;
}

export function formatBytesRateShort(bytes: number): string {
  return `${formatBytesShort(bytes)}/s`;
}

// ---------------------------------------------------------------------------
// CPU
//
// cAdvisor reports per-core percent: 100 is one core saturated, so a 32-core
// host tops out at 3200. Cores is the unit Docker takes limits in, so every
// CPU figure in the UI is rendered through here.
// ---------------------------------------------------------------------------

const PERCENT_PER_CORE = 100;

/** What a CPU figure is measured against. Mirrors LimitKind. */
export type CpuCeiling =
  /** The subject's own cap, enforced by the kernel. */
  | { kind: "enforced"; cores: number }
  /** The host the subject shares with everything else on it. */
  | { kind: "capacity"; cores: number }
  /** Nothing bounds it. */
  | { kind: "none" };

export type CpuDisplay = {
  /** Cores in use. Never capped. Null when nothing was measured. */
  cores: number | null;
  /** Share of the ceiling, 0-100. Null when no ceiling is known. */
  share: number | null;
  /** The big figure: the share when bounded, cores when not. */
  headline: string;
  /** The line under the headline. Null when there is nothing to add. */
  detail: string | null;
  /** One line, for a table cell or a chip. */
  compact: string;
  /** 0-1 bar fill. Null when no ceiling is known. */
  meter: number | null;
};

const ABSENT_CPU: CpuDisplay = {
  cores: null,
  share: null,
  headline: "—",
  detail: null,
  compact: "—",
  meter: null,
};

/** Measured cores. Precision drops as the figure grows. */
function coreCount(cores: number): string {
  if (cores > 0 && cores < 0.01) return "<0.01";
  if (cores < 10) return cores.toFixed(2);
  if (cores < 100) return cores.toFixed(1);
  return String(Math.round(cores));
}

/** A configured ceiling, so trailing zeros go: 32, 2, 1.5. */
function ceilingCount(cores: number): string {
  return String(Number(cores.toFixed(2)));
}

/** A share of a ceiling, e.g. "3.9%". */
export function sharePercent(share: number): string {
  if (share === 0) return "0%";
  if (share < 0.1) return "<0.1%";
  return share < 10 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
}

/** Cores in use, e.g. "0.60 cores". Absent reads as absent, not as zero. */
export function formatCores(percent: number | null | undefined): string {
  if (percent === null || percent === undefined) return "—";
  return `${coreCount(percent / PERCENT_PER_CORE)} cores`;
}

/** Bare core count for a chart axis, e.g. "0.6". */
export function formatCoresShort(percent: number): string {
  const cores = percent / PERCENT_PER_CORE;
  return cores < 10 ? String(Number(cores.toFixed(2))) : String(Math.round(cores));
}

/** Every CPU figure the UI renders: the share against its ceiling, in cores. */
export function cpuDisplay(
  percent: number | null | undefined,
  ceiling: CpuCeiling = { kind: "none" },
): CpuDisplay {
  if (percent === null || percent === undefined) return ABSENT_CPU;

  const cores = percent / PERCENT_PER_CORE;
  const used = coreCount(cores);

  if (ceiling.kind === "none" || ceiling.cores <= 0) {
    return { cores, share: null, headline: `${used} cores`, detail: null, compact: `${used} cores`, meter: null };
  }

  // A reading drifts past its own cap between samples. The share stops at 100
  // so the bar stays readable; the core figure keeps the overshoot.
  const share = Math.min(100, (cores / ceiling.cores) * 100);
  const total = ceilingCount(ceiling.cores);
  const pct = sharePercent(share);

  return {
    cores,
    share,
    headline: pct,
    detail: `${used} of ${total} cores`,
    compact: ceiling.kind === "enforced"
      ? `${used} / ${total} cores (${pct})`
      : `${used} cores · ${pct} of host`,
    meter: share / 100,
  };
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

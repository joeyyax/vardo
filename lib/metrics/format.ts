export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return `-${formatBytes(-bytes, decimals)}`;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

/** Shorter format for Y-axis tick labels -- 0 decimals for MB+, 1 for KB */
export function formatBytesShort(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 0) return `-${formatBytesShort(-bytes)}`;
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  const d = i >= 2 ? 0 : 1; // 0 decimals for MB and above
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(d))} ${sizes[i]}`;
}

// Memory limit > 1TB is effectively "unlimited" (Docker reports host RAM or sentinel)
export function formatMemLimit(bytes: number): string {
  if (bytes === 0 || bytes > 1099511627776) return "No limit";
  return formatBytes(bytes);
}

export function formatBytesRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0 B/s";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Shorter rate format for Y-axis tick labels */
export function formatBytesRateShort(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "0 B/s";
  return `${formatBytesShort(bytesPerSec)}/s`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

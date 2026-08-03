// Barrel re-export: all public exports from the split modules
// preserving existing import paths from "@/lib/metrics/store"

export { getTsClient } from "./ts-client";

export {
  storeMetrics,
  storeDiskWrite,
  storeGpuMetrics,
  pruneStaleGpuSeries,
  queryDiskWriteRange,
  queryMetrics,
  queryByOrg,
  queryAll,
  queryMetricsPoints,
  queryByOrgPoints,
  queryAllPoints,
} from "./store-container";
export type { TimeSeriesPoint } from "./store-container";

export {
  storeDiskUsage,
  queryDiskHistory,
  getLatestDiskUsage,
  storeProjectDisk,
  getLatestProjectDiskUsage,
} from "./store-disk";

export { storeLogCounts, queryLogCounts } from "./store-errors";
export type { LogCountSample } from "./store-errors";

export {
  storeBusinessMetric,
  queryBusinessMetric,
  getLatestBusinessMetric,
  storeOrgBusinessMetric,
  queryOrgBusinessMetric,
  getLatestOrgBusinessMetric,
} from "./store-business";
export type { BusinessMetricName } from "./store-business";

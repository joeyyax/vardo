import { IntervalLoop } from "@/lib/worker/interval-loop";

export const domainMonitoringLoop = new IntervalLoop({
  name: "domain-monitoring",
  intervalMs: 5 * 60 * 1000,
  run: async () => {
    const { checkAllDomains } = await import("@/lib/domain-monitoring/monitor");
    await checkAllDomains();
  },
});

import { IntervalLoop } from "@/lib/worker/interval-loop";

/** Re-checks domain ownership challenges hourly. */
export const domainVerificationLoop = new IntervalLoop({
  name: "domain-verification",
  intervalMs: 60 * 60 * 1000,
  run: async () => {
    const { recheckDomainOwnership } = await import("@/lib/domains/recheck");
    await recheckDomainOwnership();
  },
});

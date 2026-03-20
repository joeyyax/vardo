export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startCollector } = await import("@/lib/metrics/collector");
    startCollector();
  }
}

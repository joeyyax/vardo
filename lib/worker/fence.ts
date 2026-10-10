import { AsyncLocalStorage } from "async_hooks";
import { checkFence, leasesEnabled, type Lease } from "./lease";

// Shared across Next bundles, like the loops that set it.
const g = globalThis as unknown as { __vardo_fence?: AsyncLocalStorage<Lease> };
const fenceStore = (g.__vardo_fence ??= new AsyncLocalStorage<Lease>());

/** Runs `fn` under `lease`, so `holdsFence()` inside it checks that lease. */
export function withFence<T>(lease: Lease | null, fn: () => Promise<T>): Promise<T> {
  return lease ? fenceStore.run(lease, fn) : fn();
}

/**
 * Checked right before a Docker mutation. True outside a singleton pass or with leases off;
 * false once the pass's lease passed to another holder, or when the check can't be made.
 */
export async function holdsFence(): Promise<boolean> {
  const lease = fenceStore.getStore();
  if (!lease || !leasesEnabled()) return true;
  try {
    return await checkFence(lease);
  } catch {
    return false;
  }
}

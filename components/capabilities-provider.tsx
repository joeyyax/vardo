"use client";

import { createContext, useCallback, useContext, useMemo } from "react";
import type { Capability } from "@/lib/auth/permissions";

const CapabilitiesContext = createContext<ReadonlySet<Capability>>(new Set());

/** The current member's capabilities in the current org. */
export function CapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: React.ReactNode;
}) {
  const set = useMemo(() => new Set(capabilities), [capabilities]);
  return <CapabilitiesContext.Provider value={set}>{children}</CapabilitiesContext.Provider>;
}

/** Whether the current member holds a capability. False outside the provider. */
export function useCan() {
  const set = useContext(CapabilitiesContext);
  return useCallback((cap: Capability) => set.has(cap), [set]);
}

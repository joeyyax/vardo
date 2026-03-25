import { createContext, useContext } from "react";

export interface AppDetailContextValue {
  orgId: string;
  appId: string;
  activeTab: string;
  setActiveTab: (tab: string) => void;
  selectedEnvId: string | undefined;
  setSelectedEnvId: (id: string | undefined) => void;
  deploying: boolean;
}

export const AppDetailContext = createContext<AppDetailContextValue | null>(null);

export function useAppDetail() {
  const ctx = useContext(AppDetailContext);
  if (!ctx) throw new Error("useAppDetail must be used within AppDetailContext.Provider");
  return ctx;
}

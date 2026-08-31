"use client";

import { createContext, useContext, useState } from "react";
import type { ExecutionNetwork } from "@/lib/explorer";

const ExecutionNetworkContext = createContext<{ network: ExecutionNetwork; setNetwork: (network: ExecutionNetwork) => void } | null>(null);

export function ExecutionNetworkProvider({ children }: { children: React.ReactNode }) {
  const [network, setNetwork] = useState<ExecutionNetwork>("mainnet");
  return <ExecutionNetworkContext.Provider value={{ network, setNetwork }}>{children}</ExecutionNetworkContext.Provider>;
}

export function useExecutionNetwork() {
  const value = useContext(ExecutionNetworkContext);
  if (!value) throw new Error("useExecutionNetwork must be used within ExecutionNetworkProvider");
  return value;
}

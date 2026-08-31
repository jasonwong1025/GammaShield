"use client";

import type { ReactNode } from "react";
import { explorerHref, type ExecutionNetwork, type ExplorerResource } from "@/lib/explorer";

export function ExplorerLink({ network, resource, value, children, className }: { network: ExecutionNetwork; resource: ExplorerResource; value: string; children: ReactNode; className?: string }) {
  const href = explorerHref(network, resource, value);
  if (!href) return <span className={className}>{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className={className}>{children}</a>;
}

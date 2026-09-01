"use client";

import { useEffect, useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { UnifiedCopilotChat } from "./UnifiedCopilotChat";

type Props = {
  snap: AssetSnapshot | null;
  onNavigateToHedge: (strike?: number) => void;
};

export function CopilotWidget({ snap, onNavigateToHedge }: Props) {
  const [open, setOpen] = useState(false);

  // Escape closes the panel, matching standard chat-widget behavior.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      {open && snap && (
        <div
          role="dialog"
          aria-label="Gonka AI Copilot"
          className="fixed bottom-24 right-5 z-50 flex h-[min(640px,calc(100dvh-7rem))] w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl"
        >
          <UnifiedCopilotChat
            snap={snap}
            onNavigateToHedge={(strike) => {
              onNavigateToHedge(strike);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!snap}
        aria-label={open ? "Close AI Copilot" : "Open AI Copilot"}
        aria-expanded={open}
        title="Gonka AI Copilot"
        className="fixed bottom-5 right-5 z-50 flex size-14 items-center justify-center rounded-full bg-blue text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
      >
        {open ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M4 12a8 8 0 1 1 3.2 6.4L4 20l1.1-3.4A7.96 7.96 0 0 1 4 12Z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        )}
        {!open && (
          <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-panel text-[7px] font-bold text-blue">
            AI
          </span>
        )}
      </button>
    </>
  );
}

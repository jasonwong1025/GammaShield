"use client";

import { useEffect, useState } from "react";
import type { AssetSnapshot } from "@/lib/engine";
import { UnifiedCopilotChat } from "./UnifiedCopilotChat";

type Props = {
  snap: AssetSnapshot | null;
  onNavigateToAgent: (strike?: number) => void;
};

export function CopilotWidget({ snap, onNavigateToAgent }: Props) {
  const [open, setOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  // Escape closes the panel, matching standard chat-widget behavior.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setHasUnread(false);
      }
      return next;
    });
  };

  return (
    <>
      {/* Dialog container is kept mounted so background tasks & chat state persist */}
      {snap && (
        <div
          role="dialog"
          aria-label="GammaShield Copilot"
          aria-hidden={!open}
          className={`fixed bottom-24 right-5 z-50 flex h-[min(640px,calc(100dvh-7rem))] w-[min(400px,calc(100vw-2.5rem))] flex-col overflow-hidden rounded-2xl border border-edge bg-panel shadow-2xl transition-all duration-200 origin-bottom-right ${
            open
              ? "opacity-100 scale-100 pointer-events-auto"
              : "opacity-0 scale-95 pointer-events-none invisible"
          }`}
        >
          <UnifiedCopilotChat
            snap={snap}
            isOpen={open}
            onNavigateToHedge={(strike) => {
              onNavigateToAgent(strike);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
            onProcessingChange={(loading) => setIsProcessing(loading)}
            onNewAiMessage={() => {
              if (!open) {
                setHasUnread(true);
              }
            }}
          />
        </div>
      )}

      {/* Background Processing Hint Pill (shown when user closed widget while processing) */}
      {!open && isProcessing && (
        <div className="fixed bottom-7 right-22 z-50 flex items-center gap-2 px-3 py-1.5 rounded-full bg-panel border border-edge shadow-lg text-[11.5px] font-medium text-fg animate-pulse pointer-events-none">
          <span className="size-2 rounded-full bg-blue animate-ping" />
          <span>Analyzing in background…</span>
        </div>
      )}

      {/* Answer Ready Hint Pill (shown when processing completed while widget was closed) */}
      {!open && !isProcessing && hasUnread && (
        <button
          type="button"
          onClick={handleToggle}
          className="fixed bottom-7 right-22 z-50 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-panel border border-blue/40 shadow-xl text-[12px] font-semibold text-fg hover:border-blue transition active:scale-95 group animate-bounce"
        >
          <span className="size-2 rounded-full bg-calm shrink-0" />
          <span>✨ Answer ready!</span>
        </button>
      )}

      {/* Floating Trigger Button */}
      <button
        type="button"
        onClick={handleToggle}
        disabled={!snap}
        aria-label={open ? "Close Copilot" : "Open Copilot"}
        aria-expanded={open}
        title="GammaShield Copilot"
        className={`fixed bottom-5 right-5 z-50 flex size-14 items-center justify-center rounded-full bg-blue text-white shadow-lg transition hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:pointer-events-none ${
          !open && isProcessing ? "ring-4 ring-blue/30" : ""
        }`}
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

        {/* AI Tag / Status Badge */}
        {!open && !isProcessing && !hasUnread && (
          <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-panel text-[7px] font-bold text-blue shadow-xs">
            AI
          </span>
        )}

        {/* Active Processing Indicator */}
        {!open && isProcessing && (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center">
            <span className="size-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
          </span>
        )}

        {/* Unread Completed Answer Notification Badge */}
        {!open && hasUnread && (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-calm opacity-75" />
            <span className="relative inline-flex size-3.5 rounded-full bg-calm border-2 border-panel shadow-xs" />
          </span>
        )}
      </button>
    </>
  );
}

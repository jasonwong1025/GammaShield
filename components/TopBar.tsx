"use client";

import { WalletConnect } from "./WalletConnect";

export function TopBar() {
  return (
    <div className="shrink-0">
      <header className="flex items-center gap-6 px-5 h-16 border-b border-edge bg-bg/80 backdrop-blur">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/gammashield-lockup.png"
          alt="GammaShield"
          className="h-9 w-auto shrink-0"
        />

        <nav className="hidden md:flex items-center gap-1 ml-4 text-[13px]" aria-label="Sections">
          <a
            href="#"
            aria-current="page"
            className="px-3 py-1.5 rounded-lg bg-bluesoft text-fg font-medium"
          >
            Dashboard
          </a>
          <span className="px-3 py-1.5 rounded-lg text-faint cursor-default" title="Coming next">
            Hedge
          </span>
          <span className="px-3 py-1.5 rounded-lg text-faint cursor-default" title="Coming next">
            Copilot
          </span>
        </nav>

        <div className="ml-auto flex items-center gap-3">
          <WalletConnect />
        </div>
      </header>
    </div>
  );
}

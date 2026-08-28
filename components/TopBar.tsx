"use client";

export function TopBar() {
  return (
    <div className="shrink-0">
      <header className="flex items-center gap-6 px-5 h-16 border-b border-edge bg-bg/80 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <ShieldMark />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-tight">GammaShield</div>
            <div className="text-[10px] text-faint -mt-0.5">Amplification risk engine</div>
          </div>
        </div>

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
          <button
            className="h-9 px-4 rounded-lg bg-blue text-white text-[13px] font-medium hover:brightness-110 transition"
            title="Wallet connection lands with the hedge flow"
          >
            Connect wallet
          </button>
        </div>
      </header>
    </div>
  );
}

function ShieldMark() {
  return (
    <svg width="30" height="32" viewBox="0 0 20 22" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id="gs-shield" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3178f2" />
          <stop offset="100%" stopColor="#1e4fae" />
        </linearGradient>
      </defs>
      <path
        d="M10 1 L18.5 4.5 V11 C18.5 16 15 19.6 10 21 C5 19.6 1.5 16 1.5 11 V4.5 Z"
        fill="url(#gs-shield)"
      />
      <path
        d="M7.2 6.8 H13 M7.6 6.8 V15.4"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

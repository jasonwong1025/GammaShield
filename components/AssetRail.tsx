"use client";

type Props = {
  asset: "BTC" | "ETH";
  onAsset: (a: "BTC" | "ETH") => void;
};

const COINS = {
  BTC: { bg: "#f7931a", glyph: "₿" },
  ETH: { bg: "#627eea", glyph: "Ξ" },
} as const;

export function AssetRail({ asset, onAsset }: Props) {
  return (
    <aside className="hidden md:flex flex-col items-center gap-2 py-4 w-[76px] shrink-0 border-r border-edge bg-bg-deep/40">
      {(["BTC", "ETH"] as const).map((a) => {
        const active = asset === a;
        const coin = COINS[a];
        return (
          <button
            key={a}
            onClick={() => onAsset(a)}
            aria-pressed={active}
            className={`flex flex-col items-center gap-1 w-16 py-2 rounded-xl transition ${
              active ? "bg-bluesoft ring-1 ring-blue/60" : "hover:bg-panel"
            }`}
          >
            <span
              className="flex items-center justify-center size-9 rounded-full text-[15px] font-bold text-white"
              style={{ background: coin.bg }}
            >
              {coin.glyph}
            </span>
            <span className={`text-[11px] font-medium ${active ? "text-fg" : "text-muted"}`}>
              {a}
            </span>
          </button>
        );
      })}
    </aside>
  );
}

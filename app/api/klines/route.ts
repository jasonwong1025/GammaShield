// Live OHLCV candles, proxied server-side. Coinbase first, Binance fallback,
// with a staleness guard. Any interval that is a multiple of a native exchange
// granularity is served by aggregating finer candles.

export type Candle = {
  time: number; // unix seconds, bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const COINBASE_API_URL =
  process.env.COINBASE_API_URL ?? "https://api.exchange.coinbase.com";
// data-api.binance.vision is Binance's official public market-data mirror;
// api.binance.com is geo-blocked on some networks.
const BINANCE_API_URL =
  process.env.BINANCE_API_URL ?? "https://data-api.binance.vision";

const COINBASE_NATIVE = [60, 300, 900, 3600, 21600, 86400];
const BINANCE_NATIVE: Record<number, string> = {
  60: "1m",
  180: "3m",
  300: "5m",
  900: "15m",
  1800: "30m",
  3600: "1h",
  7200: "2h",
  14400: "4h",
  21600: "6h",
  43200: "12h",
  86400: "1d",
  259200: "3d",
  604800: "1w",
};

const COINBASE_PRODUCTS: Record<string, string> = {
  BTC: "BTC-USD",
  ETH: "ETH-USD",
};

const BINANCE_SYMBOLS: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
};

const MIN_SEC = 60;
const MAX_SEC = 604_800;
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; candles: Candle[]; source: string }>();

function aggregate(candles: Candle[], sec: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const t = Math.floor(c.time / sec) * sec;
    const b = buckets.get(t);
    if (!b) {
      buckets.set(t, { ...c, time: t });
    } else {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fromCoinbase(asset: string, sec: number): Promise<Candle[]> {
  const base = [...COINBASE_NATIVE].reverse().find((g) => sec % g === 0);
  if (!base) throw new Error("no coinbase granularity");
  const product = COINBASE_PRODUCTS[asset];
  if (!product) throw new Error("no coinbase market");
  const url = `${COINBASE_API_URL}/products/${product}/candles?granularity=${base}`;
  const res = await fetch(url, {
    headers: { "user-agent": "gammashield-hackathon" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`coinbase ${res.status}`);
  const rows: number[][] = await res.json();
  const candles = rows
    .map((r) => ({ time: r[0], open: r[3], high: r[2], low: r[1], close: r[4], volume: r[5] }))
    .sort((a, b) => a.time - b.time);
  return base === sec ? candles : aggregate(candles, sec);
}

async function fromBinance(asset: string, sec: number): Promise<Candle[]> {
  const native = BINANCE_NATIVE[sec];
  const baseSec = native
    ? sec
    : [...Object.keys(BINANCE_NATIVE).map(Number)]
        .sort((a, b) => b - a)
        .find((g) => sec % g === 0);
  if (!baseSec) throw new Error("no binance granularity");
  const symbol = BINANCE_SYMBOLS[asset];
  if (!symbol) throw new Error("no binance market");
  const url = `${BINANCE_API_URL}/api/v3/klines?symbol=${symbol}&interval=${BINANCE_NATIVE[baseSec]}&limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`binance ${res.status}`);
  const rows: unknown[][] = await res.json();
  const candles = rows.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
  }));
  return baseSec === sec ? candles : aggregate(candles, sec);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requested = searchParams.get("asset") ?? "BTC";
  const asset = BINANCE_SYMBOLS[requested] ? requested : "BTC";
  const raw = Number(searchParams.get("sec"));
  const sec =
    Number.isFinite(raw) && raw >= MIN_SEC && raw <= MAX_SEC && raw % 60 === 0 ? raw : 3600;

  const key = `${asset}:${sec}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return Response.json({ candles: hit.candles, source: hit.source, cached: true });
  }

  const fresh = (candles: Candle[]) =>
    candles.length > 0 && Date.now() / 1000 - candles[candles.length - 1].time < sec * 3;

  try {
    let candles: Candle[];
    let source: string;
    try {
      candles = await fromCoinbase(asset, sec);
      source = "coinbase";
      if (!fresh(candles)) throw new Error("coinbase stale");
    } catch {
      candles = await fromBinance(asset, sec);
      source = "binance";
      if (!fresh(candles)) throw new Error("all price feeds stale");
    }
    cache.set(key, { at: Date.now(), candles, source });
    return Response.json({ candles, source, cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : "klines failed";
    return Response.json({ error: message }, { status: 502 });
  }
}

// Server-side bridge: one upstream WebSocket, fanned out to any number of
// browser tabs over SSE. Prices arrive push-style — multiple ticks per second.
//
// Primary source is the Coinbase Exchange public ticker feed (the Thetanuts
// WS endpoint currently refuses connections; swap back via subscribePrices
// when it comes alive — the event shape here is source-agnostic).

import { EventEmitter } from "node:events";

export type PriceEvent = { symbol: string; price: number; ts: number };

export const marketEvents = new EventEmitter();
marketEvents.setMaxListeners(200);

export const latestPrices = new Map<string, PriceEvent>();

const PRODUCTS: Record<string, string> = {
  "BTC-USD": "BTC",
  "ETH-USD": "ETH",
  "SOL-USD": "SOL",
  "XRP-USD": "XRP",
  "AVAX-USD": "AVAX",
};

let started = false;

function connectUpstream() {
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  let retried = false;
  const retry = () => {
    if (retried) return;
    retried = true;
    setTimeout(connectUpstream, 3000);
  };

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: Object.keys(PRODUCTS),
        channels: ["ticker"],
      }),
    );
  };
  ws.onmessage = (m) => {
    try {
      const d = JSON.parse(String(m.data));
      const symbol = PRODUCTS[d.product_id];
      if (d.type !== "ticker" || !symbol) return;
      const price = Number(d.price);
      if (!Number.isFinite(price) || price <= 0) return;
      const ev: PriceEvent = { symbol, price, ts: Date.parse(d.time) || Date.now() };
      latestPrices.set(symbol, ev);
      marketEvents.emit("price", ev);
    } catch {
      // malformed frame — ignore
    }
  };
  ws.onclose = retry;
  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      retry();
    }
  };
}

export function ensurePriceStream(): void {
  if (started) return;
  started = true;
  connectUpstream();
}

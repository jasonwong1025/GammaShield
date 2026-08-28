"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  BarSeries,
  CandlestickSeries,
  LineSeries,
  AreaSeries,
  BaselineSeries,
  HistogramSeries,
  LineStyle,
  LineType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";

type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

// ---------- chart types ----------

type ChartTypeKey =
  | "bars"
  | "candles"
  | "hollow"
  | "heikin"
  | "line"
  | "line-markers"
  | "step"
  | "area"
  | "baseline"
  | "columns";

const CHART_TYPE_GROUPS: { items: { key: ChartTypeKey; label: string }[] }[] = [
  {
    items: [
      { key: "bars", label: "Bars" },
      { key: "candles", label: "Candles" },
      { key: "hollow", label: "Hollow candles" },
      { key: "heikin", label: "Heikin Ashi" },
    ],
  },
  {
    items: [
      { key: "line", label: "Line" },
      { key: "line-markers", label: "Line with markers" },
      { key: "step", label: "Step line" },
    ],
  },
  {
    items: [
      { key: "area", label: "Area" },
      { key: "baseline", label: "Baseline" },
      { key: "columns", label: "Columns" },
    ],
  },
];

const CHART_TYPE_LABEL = Object.fromEntries(
  CHART_TYPE_GROUPS.flatMap((g) => g.items.map((i) => [i.key, i.label])),
) as Record<ChartTypeKey, string>;

function TypeIcon({ type }: { type: ChartTypeKey }) {
  const s = { stroke: "currentColor", strokeWidth: 1.2, fill: "none" } as const;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      {type === "bars" && (
        <path {...s} d="M5 2v11 M5 5H3 M5 9h2 M11 4v10 M11 7H9 M11 11h2" />
      )}
      {type === "candles" && (
        <>
          <path {...s} d="M5 2v2 M5 11v3 M11 1v3 M11 9v4" />
          <rect x="3.5" y="4" width="3" height="7" fill="currentColor" />
          <rect {...s} x="9.5" y="4" width="3" height="5" />
        </>
      )}
      {type === "hollow" && (
        <>
          <path {...s} d="M5 2v2 M5 10v4 M11 1v3 M11 10v4" />
          <rect {...s} x="3.5" y="4" width="3" height="6" />
          <rect {...s} x="9.5" y="4" width="3" height="6" />
        </>
      )}
      {type === "heikin" && (
        <>
          <path {...s} d="M5 4v2 M5 12v2 M11 1v2 M11 8v2" />
          <rect x="3.5" y="6" width="3" height="6" rx="0.5" fill="currentColor" />
          <rect {...s} x="9.5" y="3" width="3" height="5" rx="0.5" />
        </>
      )}
      {type === "line" && <path {...s} d="M2 12 L6 6 L9.5 9 L14 3" />}
      {type === "line-markers" && (
        <>
          <path {...s} d="M2 12 L6 6 L9.5 9 L14 3" />
          <circle cx="6" cy="6" r="1.6" fill="currentColor" />
          <circle cx="9.5" cy="9" r="1.6" fill="currentColor" />
        </>
      )}
      {type === "step" && <path {...s} d="M2 13h3.5V9H9V5h3.5V2" />}
      {type === "area" && (
        <>
          <path d="M2 13 L6 6 L9.5 9 L14 3 V13 Z" fill="currentColor" opacity="0.3" />
          <path {...s} d="M2 13 L6 6 L9.5 9 L14 3" />
        </>
      )}
      {type === "baseline" && (
        <>
          <path {...s} strokeDasharray="2 2" d="M2 8h12" />
          <path {...s} d="M2 11 C5 4, 8 13, 14 5" />
        </>
      )}
      {type === "columns" && (
        <>
          <rect x="3" y="8" width="2.6" height="6" fill="currentColor" />
          <rect x="6.7" y="4" width="2.6" height="10" fill="currentColor" />
          <rect x="10.4" y="10" width="2.6" height="4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

// ---------- intervals ----------

type Interval = { label: string; sec: number; live?: boolean };

const INTERVAL_GROUPS: { title: string; items: Interval[] }[] = [
  {
    title: "Seconds",
    items: [
      { label: "1s", sec: 1, live: true },
      { label: "5s", sec: 5, live: true },
      { label: "15s", sec: 15, live: true },
      { label: "30s", sec: 30, live: true },
    ],
  },
  {
    title: "Minutes",
    items: [
      { label: "1m", sec: 60 },
      { label: "3m", sec: 180 },
      { label: "5m", sec: 300 },
      { label: "15m", sec: 900 },
      { label: "30m", sec: 1800 },
      { label: "45m", sec: 2700 },
    ],
  },
  {
    title: "Hours",
    items: [
      { label: "1H", sec: 3600 },
      { label: "2H", sec: 7200 },
      { label: "4H", sec: 14400 },
      { label: "6H", sec: 21600 },
      { label: "12H", sec: 43200 },
    ],
  },
  {
    title: "Days",
    items: [
      { label: "1D", sec: 86400 },
      { label: "3D", sec: 259200 },
      { label: "1W", sec: 604800 },
    ],
  },
];

const QUICK_INTERVALS = ["15m", "1H", "4H", "1D"];
const ALL_INTERVALS = INTERVAL_GROUPS.flatMap((g) => g.items);

const POLL_MS = 15_000;

const COLORS = {
  calm: "#34c08b",
  crit: "#e4574f",
  blue: "#3178f2",
  muted: "#8b96ad",
  edge: "#1f2b4a",
};

// ---------- data transforms ----------

function toHeikinAshi(raw: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen = i === 0 ? (c.open + c.close) / 2 : (out[i - 1].open + out[i - 1].close) / 2;
    out.push({
      time: c.time,
      open: haOpen,
      close: haClose,
      high: Math.max(c.high, haOpen, haClose),
      low: Math.min(c.low, haOpen, haClose),
      volume: c.volume,
    });
  }
  return out;
}

function mapSeriesData(type: ChartTypeKey, raw: Candle[]) {
  const src = type === "heikin" ? toHeikinAshi(raw) : raw;
  switch (type) {
    case "bars":
    case "candles":
    case "hollow":
    case "heikin":
      return src.map((c) => ({
        time: c.time as UTCTimestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }));
    case "columns":
      return src.map((c) => ({
        time: c.time as UTCTimestamp,
        value: c.close,
        color: c.close >= c.open ? COLORS.calm : COLORS.crit,
      }));
    default:
      return src.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }));
  }
}

// ---------- component ----------

export function PriceChart({
  asset,
  flip,
  livePrice,
}: {
  asset: "BTC" | "ETH";
  flip: number | null;
  livePrice?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainRef = useRef<ISeriesApi<SeriesType> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const flipLineRef = useRef<IPriceLine | null>(null);
  const rawRef = useRef<Candle[]>([]);

  const [chartType, setChartType] = useState<ChartTypeKey>("candles");
  const [interval, setIntervalTf] = useState<Interval>(
    ALL_INTERVALS.find((i) => i.label === "1H")!,
  );
  const [source, setSource] = useState<string | null>(null);
  const flipRef = useRef<number | null>(null);

  const attachFlipLine = useCallback(() => {
    const main = mainRef.current;
    if (!main) return;
    if (flipLineRef.current) {
      main.removePriceLine(flipLineRef.current);
      flipLineRef.current = null;
    }
    if (flipRef.current !== null) {
      flipLineRef.current = main.createPriceLine({
        price: flipRef.current,
        color: "#e9b44c",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "gamma flip",
      });
    }
  }, []);

  // Create the chart shell once.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: COLORS.muted,
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: "rgba(31, 43, 74, 0.45)" },
        horzLines: { color: "rgba(31, 43, 74, 0.45)" },
      },
      crosshair: {
        vertLine: { labelBackgroundColor: "#1b2848" },
        horzLine: { labelBackgroundColor: "#1b2848" },
      },
      rightPriceScale: { borderColor: COLORS.edge },
      timeScale: { borderColor: COLORS.edge, timeVisible: true, secondsVisible: true },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chartRef.current = chart;
    volumeRef.current = volume;
    return () => {
      chart.remove();
      chartRef.current = null;
      mainRef.current = null;
      volumeRef.current = null;
      flipLineRef.current = null;
    };
  }, []);

  // (Re)create the main series when the chart type changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (mainRef.current) {
      chart.removeSeries(mainRef.current);
      mainRef.current = null;
      flipLineRef.current = null;
    }

    const s = (() => {
      switch (chartType) {
        case "bars":
          return chart.addSeries(BarSeries, {
            upColor: COLORS.calm,
            downColor: COLORS.crit,
          });
        case "hollow":
          return chart.addSeries(CandlestickSeries, {
            upColor: "rgba(0,0,0,0)",
            downColor: COLORS.crit,
            borderUpColor: COLORS.calm,
            borderDownColor: COLORS.crit,
            wickUpColor: COLORS.calm,
            wickDownColor: COLORS.crit,
            borderVisible: true,
          });
        case "candles":
        case "heikin":
          return chart.addSeries(CandlestickSeries, {
            upColor: COLORS.calm,
            downColor: COLORS.crit,
            wickUpColor: COLORS.calm,
            wickDownColor: COLORS.crit,
            borderVisible: false,
          });
        case "line":
          return chart.addSeries(LineSeries, { color: COLORS.blue, lineWidth: 2 });
        case "line-markers":
          return chart.addSeries(LineSeries, {
            color: COLORS.blue,
            lineWidth: 2,
            pointMarkersVisible: true,
            pointMarkersRadius: 3,
          });
        case "step":
          return chart.addSeries(LineSeries, {
            color: COLORS.blue,
            lineWidth: 2,
            lineType: LineType.WithSteps,
          });
        case "area":
          return chart.addSeries(AreaSeries, {
            lineColor: COLORS.blue,
            lineWidth: 2,
            topColor: "rgba(49, 120, 242, 0.35)",
            bottomColor: "rgba(49, 120, 242, 0.02)",
          });
        case "baseline":
          return chart.addSeries(BaselineSeries, {
            baseValue: {
              type: "price",
              price: rawRef.current[0]?.close ?? livePrice ?? 0,
            },
            topLineColor: COLORS.calm,
            bottomLineColor: COLORS.crit,
            topFillColor1: "rgba(52, 192, 139, 0.25)",
            topFillColor2: "rgba(52, 192, 139, 0.02)",
            bottomFillColor1: "rgba(228, 87, 79, 0.02)",
            bottomFillColor2: "rgba(228, 87, 79, 0.25)",
          });
        case "columns":
          return chart.addSeries(HistogramSeries, {});
      }
    })();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    s.setData(mapSeriesData(chartType, rawRef.current) as any);
    mainRef.current = s;
    flipLineRef.current = null;
    attachFlipLine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartType]);

  const applyRaw = useCallback(
    (fit: boolean) => {
      const main = mainRef.current;
      const volume = volumeRef.current;
      if (!main || !volume) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      main.setData(mapSeriesData(chartType, rawRef.current) as any);
      volume.setData(
        rawRef.current.map((c) => ({
          time: c.time as UTCTimestamp,
          value: c.volume,
          color: c.close >= c.open ? "rgba(52, 192, 139, 0.25)" : "rgba(228, 87, 79, 0.25)",
        })),
      );
      if (fit) {
        // Show a readable recent window by default; older history stays
        // reachable by panning/zooming.
        const n = rawRef.current.length;
        chartRef.current?.timeScale().setVisibleLogicalRange({
          from: Math.max(0, n - 60),
          to: n + 4,
        });
      }
    },
    [chartType],
  );

  // Load history for the selected asset/interval (or reset for live-built).
  useEffect(() => {
    let cancelled = false;
    let first = true;
    rawRef.current = [];
    applyRaw(false);

    if (interval.live) return;

    const load = async () => {
      try {
        const res = await fetch(`/api/klines?asset=${asset}&sec=${interval.sec}`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data: { candles: Candle[]; source: string } = await res.json();
        if (cancelled) return;
        rawRef.current = data.candles;
        setSource(data.source);
        applyRaw(first);
        first = false;
      } catch {
        // transient network failure — next poll retries
      }
    };

    const initial = setTimeout(load, 0);
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(id);
    };
  }, [asset, interval, applyRaw]);

  // Tick the current bucket with each live price. For seconds intervals this
  // *builds* the chart in real time from the stream.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || !livePrice || livePrice <= 0) return;
    const raw = rawRef.current;
    const last = raw[raw.length - 1];
    // Guard against a feed briefly serving the other asset after a switch.
    if (last && Math.abs(livePrice - last.close) / last.close > 0.2) return;

    const bucket = Math.floor(Date.now() / 1000 / interval.sec) * interval.sec;
    if (!last || bucket > last.time) {
      const open = last?.close ?? livePrice;
      raw.push({
        time: bucket,
        open,
        high: Math.max(open, livePrice),
        low: Math.min(open, livePrice),
        close: livePrice,
        volume: 0,
      });
    } else {
      last.high = Math.max(last.high, livePrice);
      last.low = Math.min(last.low, livePrice);
      last.close = livePrice;
    }

    const mapped = mapSeriesData(chartType, raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    main.update(mapped[mapped.length - 1] as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice]);

  // Gamma-flip price line follows the engine (and survives series swaps).
  useEffect(() => {
    flipRef.current = flip;
    attachFlipLine();
  }, [flip, asset, source, attachFlipLine]);

  return (
    <section className="card p-5 pb-3" aria-label="Price chart">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[14px] font-semibold">{asset}/USD</h2>
          <p className="text-[12px] text-muted mt-0.5">
            Live market data with the engine&apos;s gamma flip level overlaid.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 rounded-lg bg-panel2 p-0.5">
            {QUICK_INTERVALS.map((label) => {
              const item = ALL_INTERVALS.find((i) => i.label === label)!;
              return (
                <button
                  key={label}
                  onClick={() => setIntervalTf(item)}
                  aria-pressed={interval.label === label}
                  className={`px-2.5 h-7 rounded-md text-[12px] font-medium transition ${
                    interval.label === label ? "bg-panel3 text-fg" : "text-muted hover:text-fg"
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <Menu
              label={
                QUICK_INTERVALS.includes(interval.label) ? "More" : interval.label
              }
              active={!QUICK_INTERVALS.includes(interval.label)}
            >
              {(close) => (
                <div className="w-[148px] max-h-[300px] overflow-y-auto feed-scroll">
                  {INTERVAL_GROUPS.map((group) => (
                    <div key={group.title}>
                      <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wide text-faint border-b border-edge/60 mb-1">
                        {group.title}
                      </div>
                      {group.items.map((item) => (
                        <MenuItem
                          key={item.label}
                          selected={interval.label === item.label}
                          onClick={() => {
                            setIntervalTf(item);
                            close();
                          }}
                        >
                          <span className="flex items-center justify-between">
                            {item.label}
                            {item.live && (
                              <span className="text-[9px] text-calm">● live</span>
                            )}
                          </span>
                        </MenuItem>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </Menu>
          </div>

          <Menu
            label={
              <span className="flex items-center gap-1.5">
                <TypeIcon type={chartType} />
                <span className="hidden sm:inline">{CHART_TYPE_LABEL[chartType]}</span>
              </span>
            }
            active
          >
            {(close) => (
              <div className="min-w-[184px]">
                {CHART_TYPE_GROUPS.map((group, gi) => (
                  <div key={gi} className={gi > 0 ? "border-t border-edge mt-1 pt-1" : ""}>
                    {group.items.map((item) => (
                      <MenuItem
                        key={item.key}
                        selected={chartType === item.key}
                        onClick={() => {
                          setChartType(item.key);
                          close();
                        }}
                      >
                        <span className="flex items-center gap-2.5">
                          <TypeIcon type={item.key} />
                          {item.label}
                        </span>
                      </MenuItem>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </Menu>
        </div>
      </div>

      <div ref={containerRef} className="mt-3 h-[320px] w-full" />

      <div className="mt-1 flex items-center justify-between text-[10px] text-faint">
        <span>
          {interval.live
            ? `Building ${interval.label} candles live from the tick stream`
            : source
              ? `Data: ${source === "binance" ? "Binance" : "Coinbase"} spot · ${interval.label}`
              : "Loading candles…"}
        </span>
        <span>Chart: TradingView Lightweight Charts™</span>
      </div>
    </section>
  );
}

// ---------- tiny dropdown ----------

function Menu({
  label,
  active,
  children,
}: {
  label: React.ReactNode;
  active?: boolean;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`flex items-center gap-1 px-2.5 h-7 rounded-md text-[12px] font-medium transition ${
          active ? "bg-panel3 text-fg" : "text-muted hover:text-fg"
        }`}
      >
        {label}
        <svg width="8" height="5" viewBox="0 0 8 5" aria-hidden>
          <path d="M1 1 L4 4 L7 1" stroke="currentColor" strokeWidth="1.2" fill="none" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 z-30 rounded-xl border border-edge bg-panel2 p-1.5 shadow-[0_12px_32px_rgba(4,8,20,0.6)]">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left px-2.5 py-1.5 rounded-md text-[12px] whitespace-nowrap transition ${
        selected ? "bg-bluesoft text-fg font-medium" : "text-muted hover:text-fg hover:bg-panel3"
      }`}
    >
      {children}
    </button>
  );
}

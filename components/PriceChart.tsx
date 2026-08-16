"use client";

import { useMemo, useState } from "react";
import { money } from "@/lib/format";

export interface ChartPoint {
  ts: string;
  marketPrice: number;
  fairValue: number;
}

interface Props {
  points: ChartPoint[];
  /** Show the fair-value line as well as the market line. */
  showFairValue?: boolean;
  height?: number;
}

/**
 * The two lines that make this app what it is:
 *   - MARKET  (solid, colored by direction) — what people are paying.
 *   - PERFORMANCE (dashed, blue) — what the athlete's production alone is worth.
 *
 * Hand-rolled SVG rather than a chart library: it is a handful of paths, it
 * ships no extra bytes, and it renders identically on the server.
 */
/**
 * Time windows over real traded history.
 *
 * Unlike the career chart, whose points are seasons because that is the
 * granularity the stat feeds report, this chart is made of actual price ticks —
 * so a genuine time axis exists and the ranges are real durations. A range with
 * no ticks inside it is offered but marked, rather than hidden: "nothing
 * happened this week" is information, and silently falling back to a wider
 * window would misrepresent when the trading occurred.
 */
const TIME_RANGES = [
  { id: "1D", label: "1D", ms: 24 * 60 * 60 * 1000 },
  { id: "1W", label: "1W", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "1M", label: "1M", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "1Y", label: "1Y", ms: 365 * 24 * 60 * 60 * 1000 },
  { id: "ALL", label: "ALL", ms: Infinity },
] as const;

export function PriceChart({ points: allPoints, showFairValue = true, height = 240 }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState<string>("ALL");

  const points = useMemo(() => {
    const window = TIME_RANGES.find((r) => r.id === range);
    if (!window || window.ms === Infinity) return allPoints;
    const cutoff = Date.now() - window.ms;
    const inside = allPoints.filter((p) => new Date(p.ts).getTime() >= cutoff);
    // One point cannot be drawn as a line; show the flat state instead of an
    // empty box so the range still reads as "quiet", not "broken".
    return inside.length >= 2 ? inside : allPoints.slice(-2);
  }, [allPoints, range]);

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const W = 1000;
    const H = height;
    const padY = 16;

    const values = points.flatMap((p) =>
      showFairValue ? [p.marketPrice, p.fairValue] : [p.marketPrice]
    );
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Never let a flat line collapse to a divide-by-zero.
    const span = max - min || Math.max(max * 0.1, 1);
    const lo = min - span * 0.12;
    const hi = max + span * 0.12;

    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => padY + (1 - (v - lo) / (hi - lo)) * (H - padY * 2);

    const line = (pick: (p: ChartPoint) => number) =>
      points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(pick(p)).toFixed(2)}`).join(" ");

    const marketPath = line((p) => p.marketPrice);
    const areaPath = `${marketPath} L${W},${H} L0,${H} Z`;

    return {
      W,
      H,
      x,
      y,
      marketPath,
      areaPath,
      fairPath: line((p) => p.fairValue),
      lo,
      hi,
    };
  }, [points, showFairValue, height]);

  const rangeSelector = (
    <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
      {TIME_RANGES.map((r) => {
        const cutoff = Date.now() - r.ms;
        const covered =
          r.ms === Infinity || allPoints.some((p) => new Date(p.ts).getTime() >= cutoff);
        return (
          <button
            key={r.id}
            onClick={() => {
              setRange(r.id);
              setHover(null);
            }}
            aria-pressed={range === r.id}
            title={covered ? undefined : "No trades in this window yet"}
            className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
              range === r.id
                ? "bg-ink-700 text-ink-50"
                : covered
                  ? "text-ink-400 hover:text-ink-200"
                  : "text-ink-600"
            }`}
          >
            {r.label}
          </button>
        );
      })}
    </div>
  );

  if (!geom) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-ink-700 bg-ink-850 text-sm text-ink-400"
        style={{ height }}
      >
        Not enough price history yet
      </div>
    );
  }

  const first = points[0].marketPrice;
  const last = points[points.length - 1].marketPrice;
  const up = last >= first;
  const stroke = up ? "var(--color-up)" : "var(--color-down)";
  const active = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${geom.W} ${geom.H}`}
        preserveAspectRatio="none"
        className="w-full touch-none"
        style={{ height }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const ratio = (e.clientX - rect.left) / rect.width;
          const i = Math.round(ratio * (points.length - 1));
          setHover(Math.min(Math.max(i, 0), points.length - 1));
        }}
        role="img"
        aria-label={`Price history: ${money(first)} to ${money(last)}`}
      >
        <defs>
          <linearGradient id="marketFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.24" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Horizontal guides */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={geom.W}
            y1={geom.H * f}
            y2={geom.H * f}
            stroke="var(--color-ink-800)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <path d={geom.areaPath} fill="url(#marketFill)" />

        {showFairValue && (
          <path
            d={geom.fairPath}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth={1.5}
            strokeDasharray="5 5"
            opacity={0.75}
            vectorEffect="non-scaling-stroke"
          />
        )}

        <path
          d={geom.marketPath}
          fill="none"
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {hover != null && (
          <g>
            <line
              x1={geom.x(hover)}
              x2={geom.x(hover)}
              y1={0}
              y2={geom.H}
              stroke="var(--color-ink-500)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={geom.x(hover)}
              cy={geom.y(points[hover].marketPrice)}
              r={4}
              fill={stroke}
              stroke="var(--color-ink-950)"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>

      {active && (
        <div className="pointer-events-none absolute left-0 top-0 flex gap-4 rounded-lg border border-ink-700 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-400">Market</div>
            <div className="tnum font-semibold" style={{ color: stroke }}>
              {money(active.marketPrice)}
            </div>
          </div>
          {showFairValue && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-400">Performance</div>
              <div className="tnum font-semibold text-accent">{money(active.fairValue)}</div>
            </div>
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-400">Date</div>
            <div className="tnum text-ink-200">
              {new Date(active.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-400">
        {rangeSelector}
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: stroke }} />
          {/* With no trades the two lines are the same number, so claiming a
              separate "market price" line would be inventing a distinction. */}
          {showFairValue ? "Market price" : "Performance value"}
        </span>
        {showFairValue && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4 rounded"
              style={{
                backgroundImage:
                  "repeating-linear-gradient(90deg, var(--color-accent) 0 4px, transparent 4px 8px)",
              }}
            />
            Performance value
          </span>
        )}
      </div>
    </div>
  );
}

/** Compact inline trend line for dense table rows. */
export function Sparkline({
  points,
  width = 88,
  height = 28,
}: {
  points: number[];
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * width;
      const y = height - 2 - ((v - min) / span) * (height - 4);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden="true">
      <path
        d={d}
        fill="none"
        stroke={up ? "var(--color-up)" : "var(--color-down)"}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

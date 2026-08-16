"use client";

import { useMemo, useState } from "react";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import type { PortfolioPoint } from "@/lib/market/portfolio";

/** Everyone starts here, so profit is measured from the same line. */
const STARTING_CASH = 100_000;

/**
 * Net worth over time.
 *
 * Recorded daily rather than reconstructed, because replaying every trade
 * against the prices that applied at the time would be a guess — those prices
 * move. Each point is what the portfolio was genuinely worth that morning.
 *
 * The $100,000 starting line is drawn as a reference, because "am I up or down
 * overall" is the question this chart is actually asked.
 */
export function PortfolioChart({
  points,
  height = 200,
}: {
  points: PortfolioPoint[];
  height?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const W = 1000;
    const H = height;
    const padY = 16;

    const values = points.map((p) => p.netWorth);
    const min = Math.min(...values, STARTING_CASH);
    const max = Math.max(...values, STARTING_CASH);
    const span = max - min || Math.max(max * 0.02, 1);
    const lo = min - span * 0.12;
    const hi = max + span * 0.12;

    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => padY + (1 - (v - lo) / (hi - lo)) * (H - padY * 2);
    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.netWorth).toFixed(2)}`)
      .join(" ");

    return { W, H, x, y, path, area: `${path} L${W},${H} L0,${H} Z` };
  }, [points, height]);

  if (!geom) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-850 px-6 text-center text-sm text-ink-400"
        style={{ height }}
      >
        {points.length === 1
          ? "Your first day is recorded. The line appears once there are two."
          : "Net worth is recorded once a day — your chart starts tomorrow."}
      </div>
    );
  }

  const latest = points[points.length - 1];
  const profit = latest.netWorth - STARTING_CASH;
  const up = profit >= 0;
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
        aria-label={`Net worth over ${points.length} days, now ${money(latest.netWorth)}`}
      >
        <defs>
          <linearGradient id="pfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* Where everyone started, so up and down are unambiguous. */}
        <line
          x1={0}
          x2={geom.W}
          y1={geom.y(STARTING_CASH)}
          y2={geom.y(STARTING_CASH)}
          stroke="var(--color-ink-600)"
          strokeWidth={1}
          strokeDasharray="4 4"
          vectorEffect="non-scaling-stroke"
        />

        <path d={geom.area} fill="url(#pfFill)" />
        <path
          d={geom.path}
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
              cy={geom.y(points[hover].netWorth)}
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
        <div className="pointer-events-none absolute left-0 top-0 rounded-lg border border-ink-700 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
          <div className="tnum text-sm font-semibold text-ink-100">{money(active.netWorth)}</div>
          <div className="mt-0.5 text-ink-400">
            {money(active.cash)} cash · {money(active.holdingsValue)} holdings
          </div>
          <div className="text-[10px] text-ink-500">
            {new Date(active.ts).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-ink-400">
        <span>
          {points.length} day{points.length === 1 ? "" : "s"} recorded
        </span>
        <span className={`tnum ${trendClass(profit)}`}>
          {signedMoney(profit)} ({signedPct((profit / STARTING_CASH) * 100)}) all time
        </span>
      </div>
    </div>
  );
}

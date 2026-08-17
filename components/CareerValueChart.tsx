"use client";

import { useMemo, useState } from "react";
import { money } from "@/lib/format";
import type { CareerValuePoint } from "@/lib/market/types";

/**
 * What the athlete was worth each season since their rookie year.
 *
 * The market price chart is flat until somebody trades — correctly, because
 * nothing has happened yet. This is the chart that carries a new listing: a
 * career arc drawn in the same dollars the exchange uses, so you can see the
 * rise, the peak and the decline before deciding whether the price is fair.
 */
/**
 * Two granularities, one quantity.
 *
 * Season stats are what the feeds report, so for years the only honest points
 * were seasons — and the shortest range this chart could offer was three years.
 * Asking it for "last week" had nothing to draw.
 *
 * Recent games close that gap. Each game log entry now carries the value of the
 * trailing window ending that day, priced with the same fairValue() the season
 * points use, so 1W and 1M are the *same measurement* at a finer grain rather
 * than a different number sharing an axis. Ranges shorter than a week are not
 * offered: one game is a point, not a trend, and most sports do not play daily.
 */
const GAME_RANGES = [
  { id: "1W", label: "1W", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "1M", label: "1M", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

const SEASON_RANGES = [3, 5, 10, 0] as const;
const RANGE_LABEL: Record<number, string> = { 3: "3Y", 5: "5Y", 10: "10Y", 0: "ALL" };

export function CareerValueChart({
  points: allPoints,
  currentValue,
  height = 220,
  games = [],
}: {
  points: CareerValuePoint[];
  /** Today's fair value, drawn as a reference line. */
  currentValue?: number;
  height?: number;
  /** Recent games carrying a trailing-window value, newest first. */
  games?: Array<{ date: string; summary: string; value?: number | null }>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [range, setRange] = useState<number>(0);
  /** A game range id when one is selected, otherwise seasons. */
  const [gameRange, setGameRange] = useState<string | null>(null);

  /** Games with a value, oldest first, so they plot left to right like seasons. */
  const gamePoints = useMemo((): CareerValuePoint[] => {
    const window = GAME_RANGES.find((r) => r.id === gameRange);
    if (!window) return [];
    const cutoff = Date.now() - window.ms;
    return games
      .filter((g) => g.value != null && new Date(g.date).getTime() >= cutoff)
      .map((g) => ({
        year: new Date(g.date).getTime(),
        label: new Date(g.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        teamAbbrev: null,
        value: g.value as number,
        gamesPlayed: 1,
        summary: g.summary,
      }))
      .reverse();
  }, [games, gameRange]);

  const seasonPoints = useMemo(
    () => (range > 0 ? allPoints.slice(-range) : allPoints),
    [allPoints, range]
  );

  const points = gameRange ? gamePoints : seasonPoints;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const W = 1000;
    const H = height;
    const padY = 18;

    const values = points.map((p) => p.value);
    const min = Math.min(...values, currentValue ?? Infinity);
    const max = Math.max(...values, currentValue ?? -Infinity);
    const span = max - min || Math.max(max * 0.1, 1);
    const lo = Math.max(0, min - span * 0.15);
    const hi = max + span * 0.15;

    const x = (i: number) => (i / (points.length - 1)) * W;
    const y = (v: number) => padY + (1 - (v - lo) / (hi - lo)) * (H - padY * 2);

    const path = points
      .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(p.value).toFixed(2)}`)
      .join(" ");

    return { W, H, x, y, path, area: `${path} L${W},${H} L0,${H} Z`, lo, hi };
  }, [points, currentValue, height]);

  // Only offered when there are actually games with values inside them, so a
  // range can never be selected that has nothing to draw.
  const availableGameRanges = GAME_RANGES.filter((r) => {
    const cutoff = Date.now() - r.ms;
    return games.filter((g) => g.value != null && new Date(g.date).getTime() >= cutoff).length >= 2;
  });

  const rangeSelector = (
    <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
      {availableGameRanges.map((r) => (
        <button
          key={r.id}
          onClick={() => {
            setGameRange(r.id);
            setHover(null);
          }}
          aria-pressed={gameRange === r.id}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold uppercase transition-colors ${
            gameRange === r.id ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
          }`}
        >
          {r.label}
        </button>
      ))}
      {SEASON_RANGES.filter((r) => r === 0 || r < allPoints.length).map((r) => (
        <button
          key={r}
          onClick={() => {
            setGameRange(null);
            setRange(r);
            setHover(null);
          }}
          aria-pressed={!gameRange && range === r}
          className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors ${
            !gameRange && range === r ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
          }`}
        >
          {RANGE_LABEL[r]}
        </button>
      ))}
    </div>
  );

  if (!geom) {
    return (
      <div
        className="flex items-center justify-center rounded-xl border border-dashed border-ink-700 bg-ink-850 px-4 text-center text-sm text-ink-400"
        style={{ height }}
      >
        {points.length === 1
          ? "Only one season in this range — widen it to see the arc."
          : "No completed seasons on record."}
      </div>
    );
  }

  const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
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
        aria-label={`Career value from ${points[0].label} to ${points[points.length - 1].label}, peaking at ${money(peak.value)} in ${peak.label}`}
      >
        <defs>
          <linearGradient id="careerFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity="0" />
          </linearGradient>
        </defs>

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

        <path d={geom.area} fill="url(#careerFill)" />
        <path
          d={geom.path}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />

        {/* Every season the athlete played is a real data point, so show them. */}
        {points.map((p, i) => (
          <circle
            key={p.year}
            cx={geom.x(i)}
            cy={geom.y(p.value)}
            r={hover === i ? 4.5 : 2.5}
            fill={p.year === peak.year ? "var(--color-up)" : "var(--color-accent)"}
            stroke="var(--color-ink-950)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {currentValue != null && (
          <line
            x1={0}
            x2={geom.W}
            y1={geom.y(currentValue)}
            y2={geom.y(currentValue)}
            stroke="var(--color-ink-500)"
            strokeWidth={1}
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
        )}

        {hover != null && (
          <line
            x1={geom.x(hover)}
            x2={geom.x(hover)}
            y1={0}
            y2={geom.H}
            stroke="var(--color-ink-500)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {active && (
        <div className="pointer-events-none absolute left-0 top-0 rounded-lg border border-ink-700 bg-ink-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-ink-100">{active.label}</span>
            {active.teamAbbrev && <span className="text-ink-400">{active.teamAbbrev}</span>}
            {active.year === peak.year && (
              <span className="rounded bg-up-dim px-1 text-[10px] font-semibold uppercase text-up">
                peak
              </span>
            )}
          </div>
          <div className="tnum mt-0.5 text-sm font-semibold text-accent">{money(active.value)}</div>
          <div className="mt-0.5 text-ink-400">{active.summary}</div>
          <div className="text-[10px] text-ink-500">{active.gamesPlayed} games</div>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-ink-400">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded bg-accent" />
            {gameRange ? "Value by game" : "Value by season"}
          </span>
          {rangeSelector}
        </div>
        <span className="tnum">
          {points[0].label} – {points[points.length - 1].label} · peak{" "}
          <span className="text-up">{money(peak.value)}</span> in {peak.label}
        </span>
      </div>
    </div>
  );
}

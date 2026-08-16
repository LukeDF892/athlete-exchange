"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MarketRow } from "@/lib/market/types";
import {
  marketPremiumPct,
  CHANGE_WINDOWS,
  type ChangeWindow,
  type PriceChange,
} from "@/lib/market/types";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { PlayerAvatar, SportBadge } from "@/components/ui";

import { Sparkline } from "@/components/PriceChart";

/**
 * Rows rendered at once.
 *
 * The board lists every rostered athlete, and painting all ~1,280 rows made the
 * homepage HTML several megabytes — most of it below the fold and never seen,
 * and slow to load on a phone. Filtering and sorting still run across the full
 * list; only the rendering is capped.
 */
const PAGE_SIZE = 100;

type SortKey = "price" | "name" | "premium" | "value" | "change";
type SportFilter = "all" | "nba" | "nhl" | "mlb";

interface Props {
  players: MarketRow[];
  /** Board-wide average premium, so "expensive" is judged against the market. */
  indexPct?: number;
  /** Precomputed trend series keyed by player id, for the sparkline column. */
  trends: Record<string, number[]>;
  /** Price change per athlete for the selected window; missing = no history. */
  changes?: Record<string, PriceChange>;
  changeWindow?: ChangeWindow;
}

/** Where the board's browsing state lives between navigations. */
const STATE_KEY = "market-board-state";

interface StoredState {
  query: string;
  sport: SportFilter;
  sort: SortKey;
  visible: number;
  scrollY: number;
}

function readStored(): StoredState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as StoredState) : null;
  } catch {
    return null;
  }
}

export function MarketBoard({
  players,
  trends,
  indexPct = 0,
  changes = {},
  changeWindow = "1D",
}: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Restored synchronously on first render so the list is already the right
  // length before the browser tries to put the scroll position back.
  const restored = useRef<StoredState | null>(null);
  if (restored.current === null && typeof window !== "undefined") {
    restored.current = readStored() ?? {
      query: "",
      sport: "all",
      sort: "price",
      visible: PAGE_SIZE,
      scrollY: 0,
    };
  }
  const initial = restored.current;

  const [query, setQuery] = useState(initial?.query ?? "");
  const [sport, setSport] = useState<SportFilter>(initial?.sport ?? "all");
  const [sort, setSort] = useState<SortKey>(initial?.sort ?? "price");
  const [visible, setVisible] = useState(initial?.visible ?? PAGE_SIZE);
  // Percent or dollars for the change column. Percent leads by default because
  // it compares a $5 listing and a $400 one on the same footing; dollars
  // answers "what did this actually cost me", which matters once you hold it.
  const [changeUnit, setChangeUnit] = useState<"pct" | "abs">("pct");

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = players;

    if (sport !== "all") list = list.filter((p) => p.sport === sport);
    if (q) {
      list = list.filter(
        (p) =>
          p.fullName.toLowerCase().includes(q) ||
          (p.teamAbbrev ?? "").toLowerCase().includes(q) ||
          (p.teamName ?? "").toLowerCase().includes(q) ||
          (p.position ?? "").toLowerCase().includes(q)
      );
    }

    const sorted = [...list];
    switch (sort) {
      case "name":
        sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
        break;
      case "premium":
        sorted.sort((a, b) => marketPremiumPct(b) - marketPremiumPct(a));
        break;
      case "change":
        sorted.sort(
          (a, b) => (changes[b.id]?.pct ?? -Infinity) - (changes[a.id]?.pct ?? -Infinity)
        );
        break;
      case "value":
        sorted.sort((a, b) => b.fairValue - a.fairValue);
        break;
      default:
        sorted.sort((a, b) => b.marketPrice - a.marketPrice);
    }
    return sorted;
  }, [players, query, sport, sort, changes]);

  const shown = rows.slice(0, visible);

  /**
   * Keep your place when you come back from a player page.
   *
   * The browser restores scroll on back, but this list renders a capped window
   * of rows: on remount it was starting at 100 again, so the page was shorter
   * than it had been and the scroll target no longer existed — you landed at
   * the top. Persisting the visible count alongside the offset means the list
   * is the same height on return, so the position is real.
   */
  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(
          STATE_KEY,
          JSON.stringify({ query, sport, sort, visible, scrollY: window.scrollY })
        );
      } catch {
        // Private browsing or a full quota — losing scroll position is not
        // worth breaking the page over.
      }
    };
    // Navigations in the App Router do not always fire pagehide, so capture on
    // any click that could leave the page as well.
    window.addEventListener("pagehide", save);
    document.addEventListener("click", save, true);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      document.removeEventListener("click", save, true);
    };
  }, [query, sport, sort, visible]);

  useEffect(() => {
    const y = initial?.scrollY ?? 0;
    if (y <= 0) return;
    // Two frames: one for this render to commit, one for layout to settle with
    // images sized, so the target offset actually exists.
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => window.scrollTo(0, y))
    );
    return () => cancelAnimationFrame(id);
    // Runs once on mount; `initial` is captured at first render by design.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 sm:max-w-xs">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="9" cy="9" r="6" />
            <path d="M14 14l4 4" strokeLinecap="round" />
          </svg>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              // A new search should start from the top of its results.
              setVisible(PAGE_SIZE);
            }}
            placeholder="Search players or teams"
            aria-label="Search players or teams"
            className="w-full rounded-lg border border-ink-700 bg-ink-850 py-2 pl-9 pr-3 text-sm text-ink-100 placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
            {(["all", "nba", "nhl", "mlb"] as const).map((s) => (
              <button
                key={s}
                onClick={() => {
                setSport(s);
                setVisible(PAGE_SIZE);
              }}
                aria-pressed={sport === s}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                  sport === s ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
            {(["pct", "abs"] as const).map((u) => (
              <button
                key={u}
                onClick={() => setChangeUnit(u)}
                aria-pressed={changeUnit === u}
                title={u === "pct" ? "Show change as a percentage" : "Show change in dollars"}
                className={`rounded-md px-2 py-1.5 text-xs font-semibold transition-colors ${
                  changeUnit === u ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {u === "pct" ? "%" : "$"}
              </button>
            ))}
          </div>

          <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
            {CHANGE_WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => {
                  const next = new URLSearchParams(searchParams.toString());
                  next.set("change", w);
                  // Server re-renders with only the selected window's data, so
                  // the payload does not grow as history accumulates.
                  router.push(`${pathname}?${next.toString()}`, { scroll: false });
                }}
                aria-pressed={changeWindow === w}
                className={`rounded-md px-2 py-1.5 text-xs font-semibold uppercase transition-colors ${
                  changeWindow === w ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
                }`}
              >
                {w}
              </button>
            ))}
          </div>

          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as SortKey);
              setVisible(PAGE_SIZE);
            }}
            aria-label="Sort by"
            className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs font-medium text-ink-200 focus:border-accent focus:outline-none"
          >
            <option value="price">Price</option>
            <option value="value">Performance value</option>
            <option value="premium">Premium vs market</option>
            <option value="change">Change</option>
            <option value="name">Name</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-ink-750">
        <div className="hidden grid-cols-[1fr_88px_92px_92px_104px_88px] items-center gap-3 border-b border-ink-750 bg-ink-875 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400 md:grid">
          <div>Athlete</div>
          <div className="text-right">Performance</div>
          <div className="text-right">Premium</div>
          <div className="text-right">Change</div>
          <div className="text-right">Price</div>
          <div className="text-right">Trend</div>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-14 text-center text-sm text-ink-400">
            No athletes match “{query}”.
          </div>
        ) : (
          <ul className="divide-y divide-ink-800">
            {shown.map((p) => {
              // Shown against zero, not against the index.
              //
              // Subtracting the board average was defensible in theory — when
              // everything is up, matching the average is not outperformance —
              // but it printed a red negative for an athlete trading ABOVE their
              // performance value, which reads as "doing badly" and is the
              // opposite of what happened. The plain reading has to win: price
              // above performance is a premium, and it is green. The index tile
              // in the header carries the market-wide context instead.
              const premium = marketPremiumPct(p);
              return (
                <li key={p.id}>
                  <Link
                    href={`/player/${p.id}`}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850 md:grid-cols-[1fr_88px_92px_92px_104px_88px]"
                  >
                    <div className="flex min-w-0 items-center gap-3">
                      <PlayerAvatar name={p.fullName} src={p.headshotUrl} size={38} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-ink-50">
                            {p.fullName}
                          </span>
                          <SportBadge sport={p.sport} />
                        </div>
                        <div className="mt-0.5 truncate text-xs text-ink-400">
                          {[p.teamAbbrev, p.position, p.ageYears ? `${p.ageYears}y` : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                    </div>

                    <div className="tnum hidden text-right text-sm text-ink-300 md:block">
                      {money(p.fairValue)}
                    </div>

                    {/* Untraded athletes sit exactly at their opening price. A
                        column of literal 0.00% reads as a bug, so say so. */}
                    <div
                      className={`hidden text-right text-sm md:block ${
                        p.sharesOutstanding > 0 ? `tnum ${trendClass(premium)}` : "text-ink-500"
                      }`}
                    >
                      {p.sharesOutstanding > 0 ? signedPct(premium) : "at open"}
                    </div>

                    <div className="hidden text-right md:block">{(() => {
                    const c = changes[p.id];
                    if (!c) return <span className="text-ink-600">—</span>;
                    // The chosen unit leads; the other sits beneath it, so
                    // switching reorders emphasis rather than hiding a number.
                    return changeUnit === "pct" ? (
                      <>
                        <div className={`tnum text-sm ${trendClass(c.pct)}`}>{signedPct(c.pct)}</div>
                        <div className={`tnum text-xs ${trendClass(c.abs)}`}>{signedMoney(c.abs)}</div>
                      </>
                    ) : (
                      <>
                        <div className={`tnum text-sm ${trendClass(c.abs)}`}>{signedMoney(c.abs)}</div>
                        <div className={`tnum text-xs ${trendClass(c.pct)}`}>{signedPct(c.pct)}</div>
                      </>
                    );
                  })()}</div>

                  <div className="text-right">
                      <div className="tnum text-sm font-semibold text-ink-50">
                        {money(p.marketPrice)}
                      </div>
                      <div
                        className={`text-xs sm:hidden ${
                          p.sharesOutstanding > 0 ? `tnum ${trendClass(premium)}` : "text-ink-500"
                        }`}
                      >
                        {p.sharesOutstanding > 0 ? signedPct(premium) : "at open"}
                      </div>
                    </div>

                    <div className="hidden justify-end sm:flex">
                      <Sparkline points={trends[p.id] ?? []} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {shown.length < rows.length && (
        <button
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="mt-3 w-full rounded-lg border border-ink-700 py-2.5 text-sm font-medium text-ink-200 transition-colors hover:bg-ink-850"
        >
          Show {Math.min(PAGE_SIZE, rows.length - shown.length)} more
        </button>
      )}

      <p className="mt-3 text-xs text-ink-400">
        Showing {shown.length} of {rows.length} matching athletes ({players.length} listed). “vs
        Market” is how far a price sits above or below the board average premium — so when the
        whole market is up, sitting at the average reads as neutral rather than expensive.
      </p>
    </div>
  );
}

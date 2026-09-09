"use client";

import Link from "next/link";
import { timeAgo } from "@/lib/format";
import type { TapeEntry } from "@/lib/market/tape-row";
import { useLiveTape } from "@/components/useLiveTape";

/**
 * The market's own activity, most recent first.
 *
 * No prices and no amounts — just who traded what. That is partly a privacy
 * decision (see the `trade_tape` view) and partly an editorial one: the point
 * is to show the room is occupied, and a wall of dollar figures would turn a
 * glance into reading.
 *
 * A tape that only updated on reload was showing the room as it was occupied
 * whenever you happened to load the page, which is the one thing a tape must
 * not do — so it now follows the market over the same websocket the board uses.
 */
export function TradeTape({ entries: initial }: { entries: TapeEntry[] }) {
  const { entries, isNew } = useLiveTape(initial, { limit: 12 });
  if (entries.length === 0) return null;

  return (
    <section className="mb-7">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Latest trades</h2>
        <span className="text-xs text-ink-500">across everyone on the exchange</span>
      </div>

      <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((t) => (
          <li key={t.id} className={`shrink-0 ${isNew(t.id) ? "rise" : ""}`}>
            <Link
              href={`/player/${t.playerId}`}
              className="flex w-56 flex-col gap-1 rounded-xl border border-ink-750 bg-ink-875 px-3 py-2.5 transition-colors hover:bg-ink-850"
            >
              <div className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`font-bold uppercase ${t.side === "buy" ? "text-up" : "text-down"}`}
                >
                  {t.side}
                </span>
                <span className="tnum text-ink-300">{t.shares.toLocaleString()}</span>
                <span className="ml-auto text-ink-500">{timeAgo(t.createdAt)}</span>
              </div>

              <div className="truncate text-sm font-medium text-ink-50">{t.playerName}</div>

              <div className="flex items-center gap-1.5 text-[11px] text-ink-400">
                {/* Same treatment as the per-player tape: visible, labelled,
                    not itemised by which bot. */}
                <span className={`truncate ${t.isBot ? "text-ink-500" : ""}`}>
                  {t.isBot ? "Market maker" : t.username}
                </span>
                {t.isBot && (
                  <span className="rounded bg-ink-800 px-1 py-0.5 text-[9px] font-bold uppercase text-ink-500">
                    auto
                  </span>
                )}
                <span className="ml-auto uppercase text-ink-500">{t.sport}</span>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

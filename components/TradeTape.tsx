import Link from "next/link";
import { timeAgo } from "@/lib/format";
import type { TapeEntry } from "@/lib/market/tape";

/**
 * The market's own activity, most recent first.
 *
 * No prices and no amounts — just who traded what. That is partly a privacy
 * decision (see the `trade_tape` view) and partly an editorial one: the point
 * is to show the room is occupied, and a wall of dollar figures would turn a
 * glance into reading.
 */
export function TradeTape({ entries }: { entries: TapeEntry[] }) {
  if (entries.length === 0) return null;

  return (
    <section className="mb-7">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Latest trades</h2>
        <span className="text-xs text-ink-500">across everyone on the exchange</span>
      </div>

      <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {entries.map((t) => (
          <li key={t.id} className="shrink-0">
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
                <span className="truncate">{t.username}</span>
                {t.isBot && (
                  <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] font-bold uppercase text-ink-300">
                    bot
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

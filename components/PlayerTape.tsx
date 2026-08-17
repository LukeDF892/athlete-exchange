import Link from "next/link";
import { timeAgo } from "@/lib/format";
import { isBotUsername } from "@/lib/bots/identity";
import type { TapeEntry } from "@/lib/market/tape";

/**
 * Who has been trading this athlete, and which way.
 *
 * No prices — the `trade_tape` view does not publish the cash a trade moved,
 * and that restraint is deliberate rather than an oversight. Direction and size
 * are what tell you whether the market is accumulating or getting out.
 */
export function PlayerTape({ entries }: { entries: TapeEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-ink-500">
        Nobody has traded this listing yet.
      </p>
    );
  }

  const buys = entries.filter((e) => e.side === "buy").length;

  return (
    <div>
      <p className="border-b border-ink-800 px-4 py-2 text-xs text-ink-400">
        Last {entries.length} trades · {buys} buying, {entries.length - buys} selling
      </p>
      <ul className="divide-y divide-ink-800">
        {entries.map((t) => (
          <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span
              className={`w-12 shrink-0 text-[11px] font-bold uppercase ${
                t.side === "buy" ? "text-up" : "text-down"
              }`}
            >
              {t.side}
            </span>
            <span className="tnum shrink-0 text-ink-200">{t.shares.toLocaleString()}</span>
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              {isBotUsername(t.username) ? (
                <Link
                  href={`/trader/${encodeURIComponent(t.username)}`}
                  className="truncate text-xs text-ink-400 underline-offset-2 hover:text-ink-200 hover:underline"
                >
                  {t.username}
                </Link>
              ) : (
                <span className="truncate text-xs text-ink-400">{t.username}</span>
              )}
              {t.isBot && (
                <span className="rounded bg-ink-700 px-1 py-0.5 text-[9px] font-bold uppercase text-ink-300">
                  bot
                </span>
              )}
            </span>
            <span className="shrink-0 text-[11px] text-ink-500">{timeAgo(t.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

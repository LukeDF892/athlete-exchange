import Link from "next/link";
import type { TradeRecord } from "@/lib/market/portfolio";
import { money, signedMoney, timeAgo, trendClass } from "@/lib/format";
import { Card, PlayerAvatar, SportBadge } from "@/components/ui";

/**
 * Every trade you have made, newest first.
 *
 * Sales carry the realized profit or loss against what those shares actually
 * cost, so the list answers "did that work out?" rather than just recording
 * that something happened.
 */
export function TradeHistory({ trades, title = "Activity" }: { trades: TradeRecord[]; title?: string }) {
  if (trades.length === 0) {
    return (
      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">{title}</h2>
        <p className="py-6 text-center text-sm text-ink-400">
          No trades yet. Your buys and sells will appear here.
        </p>
      </Card>
    );
  }

  const realizedTotal = trades.reduce((a, t) => a + (t.realized ?? 0), 0);
  const sales = trades.filter((t) => t.realized != null).length;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-ink-750 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-100">
          {title} <span className="text-ink-400">({trades.length})</span>
        </h2>
        {sales > 0 && (
          <span className="text-xs text-ink-400">
            Realized{" "}
            <span className={`tnum font-semibold ${trendClass(realizedTotal)}`}>
              {signedMoney(realizedTotal)}
            </span>
          </span>
        )}
      </div>

      <ul className="divide-y divide-ink-800">
        {trades.map((t) => (
          <li key={t.id}>
            <Link
              href={`/player/${t.playerId}`}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
            >
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                  t.action === "buy" || t.action === "cover"
                    ? "bg-up-dim text-up"
                    : "bg-down-dim text-down"
                }`}
              >
                {t.action}
              </span>

              <PlayerAvatar name={t.playerName} src={t.headshotUrl} size={30} />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-ink-100">{t.playerName}</span>
                  <SportBadge sport={t.playerSport} />
                </div>
                <div className="tnum mt-0.5 text-xs text-ink-400">
                  {t.shares} @ {money(t.avgPrice)} · {timeAgo(t.createdAt)}
                </div>
              </div>

              <div className="text-right">
                <div className="tnum text-sm font-semibold text-ink-100">
                  {t.side === "buy" ? "−" : "+"}
                  {money(t.net)}
                </div>
                {t.realized != null && (
                  <div className={`tnum text-xs ${trendClass(t.realized)}`}>
                    {signedMoney(t.realized)}
                  </div>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

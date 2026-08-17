import Link from "next/link";
import { notFound } from "next/navigation";
import { getBotPositions } from "@/lib/market/trader";
import { isBotUsername } from "@/lib/bots/identity";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { ButtonLink, Card, EmptyState, SportBadge } from "@/components/ui";

/**
 * What a bot is holding.
 *
 * Only bots have a page here. Human traders' positions stay private, which is
 * what /terms promises everyone who signs up — see lib/market/trader.ts.
 */
export const dynamic = "force-dynamic";

export default async function TraderPage(props: PageProps<"/trader/[username]">) {
  const { username } = await props.params;
  const name = decodeURIComponent(username);

  // Guarded here as well as in the view, so a hand-typed URL for a real
  // person's account cannot even reach a query.
  if (!isBotUsername(name)) notFound();

  const positions = await getBotPositions(name);
  const strategy = name.split("_")[1] ?? "";
  const totalValue = positions.reduce((a, p) => a + p.marketValue, 0);
  const totalPnl = positions.reduce((a, p) => a + p.unrealizedPnl, 0);

  return (
    <div className="rise">
      <header className="mb-6">
        <Link href="/leaderboard" className="text-xs text-ink-400 hover:text-ink-200">
          ← Ranks
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink-50">{name}</h1>
          <span className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-300">
            bot
          </span>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
          {strategy === "value"
            ? "Buys listings trading below their performance value and sells once they run past it."
            : strategy === "momentum"
              ? "Buys what has risen since yesterday's close and exits when it breaks down."
              : "Trades at random, so the market is never perfectly predictable."}{" "}
          It follows the same rules everyone does — same position limits, same prices, no special
          access.
        </p>
      </header>

      {positions.length === 0 ? (
        <EmptyState
          title="Holding nothing right now"
          body="This bot is entirely in cash. It will trade again at its next scheduled slot."
          action={<ButtonLink href="/leaderboard">Back to ranks</ButtonLink>}
        />
      ) : (
        <>
          <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Stat label="Positions" value={String(positions.length)} />
            <Stat label="Holdings value" value={money(totalValue)} />
            <Stat
              label="Unrealized P&L"
              value={signedMoney(totalPnl)}
              tone={totalPnl >= 0 ? "up" : "down"}
            />
          </section>

          <Card className="overflow-hidden">
            <ul className="divide-y divide-ink-800">
              {positions.map((p) => (
                <li key={p.playerId}>
                  <Link
                    href={`/player/${p.playerId}`}
                    className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink-100">
                          {p.playerName}
                        </span>
                        <SportBadge sport={p.sport} />
                        {p.shares < 0 && (
                          <span className="rounded bg-down-dim px-1.5 py-0.5 text-[10px] font-bold uppercase text-down">
                            short
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-ink-400">
                        {Math.abs(p.shares).toLocaleString()} shares @ {money(p.avgCost)} ·{" "}
                        {money(p.marketPrice)} now
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="tnum text-sm font-semibold text-ink-100">
                        {money(Math.abs(p.marketValue))}
                      </div>
                      <div className={`tnum text-xs ${trendClass(p.unrealizedPnl)}`}>
                        {signedMoney(p.unrealizedPnl)}
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-xl border border-ink-750 bg-ink-875 px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      <div
        className={`tnum mt-0.5 text-lg font-bold ${
          tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-ink-50"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

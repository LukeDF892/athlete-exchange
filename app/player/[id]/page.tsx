import Link from "next/link";
import { notFound } from "next/navigation";
import { getPlayer, getNewsForPlayer, getPriceHistory } from "@/lib/market/source";
import { getTradingContext, getTrades, getWatchlistIds } from "@/lib/market/portfolio";
import { WatchButton } from "@/components/WatchButton";
import { RetirementBanner } from "@/components/RetirementBanner";
import { TradeHistory } from "@/components/TradeHistory";
import { marketPremiumPct } from "@/lib/market/types";
import { money, signedMoney, signedPct, timeAgo, trendClass } from "@/lib/format";
import { PriceChart } from "@/components/PriceChart";
import { CareerValueChart } from "@/components/CareerValueChart";
import { TradePanel } from "@/components/TradePanel";
import { StatTables } from "@/components/StatTables";
import { Card, PlayerAvatar, SportBadge, StatTile } from "@/components/ui";
import { UpcomingGames } from "@/components/UpcomingGames";
import { fetchUpcoming } from "@/lib/providers/schedule";

/**
 * What you already hold in this athlete.
 *
 * Shown above the trade ticket rather than inside it, because it answers a
 * different question: the ticket is about what you are about to do, this is
 * about what you have already done.
 */
function YourPosition({
  shares,
  avgCost,
  marketPrice,
}: {
  shares: number;
  avgCost: number;
  marketPrice: number;
}) {
  const value = shares * marketPrice;
  const basis = shares * avgCost;
  const pnl = value - basis;
  const pct = basis > 0 ? (pnl / basis) * 100 : 0;

  return (
    <div className="rounded-xl border border-accent/25 bg-ink-850/70 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Your position</h2>
        <span className="tnum text-sm font-bold text-ink-50">
          {shares.toLocaleString()} {shares === 1 ? "share" : "shares"}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">Average cost</dt>
          <dd className="tnum text-ink-200">{money(avgCost)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">Market value</dt>
          <dd className="tnum text-ink-100">{money(value)}</dd>
        </div>
        <div className="my-2 border-t border-ink-750" />
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">Unrealized P&L</dt>
          <dd className={`tnum text-sm font-bold ${trendClass(pnl)}`}>
            {signedMoney(pnl)} <span className="text-xs font-medium">({signedPct(pct)})</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

export default async function PlayerPage(props: PageProps<"/player/[id]">) {
  const { id } = await props.params;
  // Window the market board was showing when this link was followed.
  const { range } = await props.searchParams;
  const player = await getPlayer(id);
  if (!player) notFound();

  const [history, news, trading, trades, watchedIds, fixtures] = await Promise.all([
    getPriceHistory(player),
    getNewsForPlayer(id),
    getTradingContext(id),
    getTrades(20, id),
    getWatchlistIds(),
    fetchUpcoming(player.sport, player.teamAbbrev),
  ]);
  const premium = marketPremiumPct(player);
  const hasTraded = player.sharesOutstanding > 0;

  return (
    <div className="rise">
      <Link
        href="/"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-ink-400 transition-colors hover:text-ink-100"
      >
        <span aria-hidden="true">←</span> Market
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <PlayerAvatar name={player.fullName} src={player.headshotUrl} size={64} />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-ink-50 sm:text-2xl">
                {player.fullName}
              </h1>
              <SportBadge sport={player.sport} />
            </div>
            <p className="mt-1 text-sm text-ink-400">
              {[
                player.teamName ?? player.teamAbbrev,
                player.position,
                player.jersey ? `#${player.jersey}` : null,
                player.ageYears ? `${player.ageYears} yrs` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
        </div>

        <div className="text-right">
          <div className="tnum text-3xl font-bold text-ink-50">{money(player.marketPrice)}</div>
          <div className={`text-sm font-medium ${hasTraded ? trendClass(premium) : "text-ink-400"}`}>
            {hasTraded ? (
              <span className="tnum">{signedPct(premium)} vs performance</span>
            ) : (
              "At opening price"
            )}
          </div>
        </div>
      </header>

      {player.status && player.status !== "active" && (
        <div className="mb-5">
          <RetirementBanner player={player} />
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-100">Career value</h2>
              <span className="rounded bg-ink-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                {player.careerValue.length} season{player.careerValue.length === 1 ? "" : "s"}
              </span>
            </div>
            <CareerValueChart
              points={player.careerValue}
              currentValue={player.fairValue}
              games={player.gameLog}
            />
            <p className="mt-3 text-xs leading-relaxed text-ink-400">
              What {player.firstName || player.fullName} would have been worth on this exchange at
              the end of each season, priced on that season&apos;s production at the age they were
              then. The dashed line is today&apos;s performance value.
            </p>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-ink-100">Market price</h2>
              {history.length > 0 && (
                <span className="rounded bg-ink-800 px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                  {history.length} tick{history.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {history.length < 2 ? (
              <div className="flex h-[240px] flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-700 bg-ink-850 px-6 text-center">
                <div className="tnum text-2xl font-bold text-ink-100">
                  {money(player.marketPrice)}
                </div>
                <p className="max-w-sm text-xs leading-relaxed text-ink-400">
                  No trades yet, so there is no price history to draw. The line starts the moment
                  someone buys — every point on it will be a real trade.
                </p>
              </div>
            ) : (
              <>
                <PriceChart
                  points={history}
                  showFairValue
                  initialRange={typeof range === "string" ? range : undefined}
                />
                <p className="mt-3 text-xs leading-relaxed text-ink-400">
                  The solid line is what people are paying. The dashed line is what this
                  athlete&apos;s production alone is worth — the gap between them is the
                  market&apos;s opinion.
                </p>
              </>
            )}
          </Card>

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Performance value" value={money(player.fairValue)} tone="accent" />
            <StatTile
              label="Market premium"
              value={hasTraded ? signedPct(premium) : "—"}
              hint={hasTraded ? undefined : "no trades yet"}
              tone={premium > 0 ? "up" : premium < 0 ? "down" : "neutral"}
            />
            <StatTile label="Shares held" value={player.sharesOutstanding.toLocaleString()} />
            <StatTile
              label="Liquidity depth"
              value={player.liquidityDepth.toLocaleString()}
              hint="shares to roughly triple the price"
            />
          </section>

          {trades.length > 0 && <TradeHistory trades={trades} title="Your trades" />}

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-100">Statistics</h2>
            <StatTables tables={player.statTables} gameLog={player.gameLog} />
          </Card>

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-100">
              News {news.length > 0 && <span className="text-ink-400">({news.length})</span>}
            </h2>
            {news.length === 0 ? (
              <p className="py-6 text-center text-sm text-ink-400">
                No recent headlines mention {player.fullName}.
              </p>
            ) : (
              <ul className="divide-y divide-ink-800">
                {news.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <a
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block py-3 transition-colors hover:bg-ink-850"
                    >
                      <div className="text-sm font-medium text-ink-100">{item.title}</div>
                      <div className="mt-1 text-xs text-ink-400">
                        {item.source} · {timeAgo(item.publishedAt)}
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <aside className="space-y-3 lg:sticky lg:top-20 lg:self-start">
          <WatchButton
            playerId={id}
            initialWatching={watchedIds.includes(id)}
            disabled={!trading.tradingEnabled}
          />
          {/* What is coming up, before the ticket — "should I buy now or wait?"
              is answered by the fixture list, not by the price. */}
          <div className="rounded-xl border border-ink-750 bg-ink-850/70 p-4">
            <h2 className="mb-2.5 text-sm font-semibold text-ink-100">Upcoming games</h2>
            <UpcomingGames fixtures={fixtures} />
          </div>

          {/* Your own stake, before the order ticket — it was previously only a
              small line inside the panel, so "how many do I own?" meant
              hunting for it or opening the portfolio. */}
          {trading.sharesHeld > 0 && (
            <YourPosition
              shares={trading.sharesHeld}
              avgCost={trading.avgCost}
              marketPrice={player.marketPrice}
            />
          )}
          <TradePanel
            player={player}
            tradingEnabled={trading.tradingEnabled}
            cash={trading.cash}
            sharesHeld={trading.sharesHeld}
            avgCost={trading.avgCost}
            blockedReason={trading.blockedReason}
          />
        </aside>
      </div>
    </div>
  );
}

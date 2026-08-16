import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import {
  getPortfolio,
  getTrades,
  getPortfolioNews,
  getWatchlist,
  getPortfolioHistory,
} from "@/lib/market/portfolio";
import { PortfolioChart } from "@/components/PortfolioChart";
import { TradeHistory } from "@/components/TradeHistory";
import { UsernameEditor } from "@/components/UsernameEditor";
import { EmailDigestToggle } from "@/components/EmailDigestToggle";
import { Tabs } from "@/components/Tabs";
import { NewsList } from "@/components/NewsList";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { ButtonLink, Card, EmptyState, PlayerAvatar, SportBadge, StatTile } from "@/components/ui";
import { signOut } from "@/app/actions/trade";

export default async function PortfolioPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="rise">
        <Header />
        <EmptyState
          title="Accounts need a database"
          body="Portfolios sync across devices in real time, which means every trader needs an account and every trade needs somewhere to live. Create a free Supabase project, run the included migration, and add three keys to .env.local — setup steps are in the README."
          action={<ButtonLink href="/">Browse the market</ButtonLink>}
        />
      </div>
    );
  }

  const [portfolio, trades, news, watchlist, history] = await Promise.all([
    getPortfolio(),
    getTrades(50),
    getPortfolioNews(25),
    getWatchlist(),
    getPortfolioHistory(),
  ]);

  if (!portfolio) {
    return (
      <div className="rise">
        <Header />
        <EmptyState
          title="Sign in to see your positions"
          body="Your holdings, cost basis and live profit and loss appear here once you are signed in."
          action={<ButtonLink href="/login">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  const { positions, totalPnl, totalPnlPct } = portfolio;

  return (
    <div className="rise">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink-50">Portfolio</h1>
          <UsernameEditor username={portfolio.username} />
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800"
          >
            Sign out
          </button>
        </form>
      </div>

      <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Net worth" value={money(portfolio.netWorth)} />
        <StatTile label="Buying power" value={money(portfolio.cash)} />
        <StatTile label="Holdings" value={money(portfolio.holdingsValue)} />
        <StatTile
          label="Unrealized P&L"
          value={signedMoney(totalPnl)}
          hint={signedPct(totalPnlPct)}
          tone={totalPnl > 0 ? "up" : totalPnl < 0 ? "down" : "neutral"}
        />
      </section>

      <Card className="mb-5 p-4">
        <h2 className="mb-3 text-sm font-semibold text-ink-100">Net worth</h2>
        <PortfolioChart points={history} />
      </Card>

      <Card className="mb-5 p-4">
        <EmailDigestToggle initial={portfolio.emailDigest} />
      </Card>

      <Tabs
        tabs={[
          {
            id: "positions",
            label: "Positions",
            count: positions.length,
            content: (
              <>
      {positions.length === 0 ? (
        <EmptyState
          title="You do not hold any athletes yet"
          body="Pick someone you believe in and buy your first shares. Prices open at what their performance justifies — the market moves from there."
          action={<ButtonLink href="/">Open the market</ButtonLink>}
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[1fr_80px_100px_110px_110px] items-center gap-3 border-b border-ink-750 bg-ink-875 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400 md:grid">
            <div>Athlete</div>
            <div className="text-right">Shares</div>
            <div className="text-right">Avg cost</div>
            <div className="text-right">Value</div>
            <div className="text-right">P&L</div>
          </div>

          <ul className="divide-y divide-ink-800">
            {positions.map((pos) => (
              <li key={pos.player.id}>
                <Link
                  href={`/player/${pos.player.id}`}
                  className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850 md:grid-cols-[1fr_80px_100px_110px_110px]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <PlayerAvatar name={pos.player.fullName} src={pos.player.headshotUrl} size={38} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-ink-50">
                          {pos.player.fullName}
                        </span>
                        <SportBadge sport={pos.player.sport} />
                      </div>
                      <div className="mt-0.5 truncate text-xs text-ink-400">
                        {money(pos.player.marketPrice)} now
                      </div>
                    </div>
                  </div>

                  <div className="tnum hidden text-right text-sm text-ink-200 md:block">
                    {pos.shares.toLocaleString()}
                  </div>
                  <div className="tnum hidden text-right text-sm text-ink-300 md:block">
                    {money(pos.avgCost)}
                  </div>
                  <div className="tnum hidden text-right text-sm text-ink-100 md:block">
                    {money(pos.marketValue)}
                  </div>

                  <div className="text-right">
                    <div className={`tnum text-sm font-semibold ${trendClass(pos.unrealizedPnl)}`}>
                      {signedMoney(pos.unrealizedPnl)}
                    </div>
                    <div className={`tnum text-xs ${trendClass(pos.unrealizedPnl)}`}>
                      {signedPct(pos.unrealizedPct)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
              </>
            ),
          },
          {
            id: "watchlist",
            label: "Following",
            count: watchlist.length,
            content:
              watchlist.length > 0 ? (
                <>
        <Card className="overflow-hidden">
          <div className="border-b border-ink-750 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-100">
              Following <span className="text-ink-400">({watchlist.length})</span>
            </h2>
            <p className="mt-0.5 text-xs text-ink-400">
              Athletes you are tracking but do not own yet.
            </p>
          </div>
          <ul className="divide-y divide-ink-800">
            {watchlist.map(({ player, premiumPct }) => (
              <li key={player.id}>
                <Link
                  href={`/player/${player.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
                >
                  <PlayerAvatar name={player.fullName} src={player.headshotUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink-100">
                        {player.fullName}
                      </span>
                      <SportBadge sport={player.sport} />
                    </div>
                    <div className="mt-0.5 text-xs text-ink-400">
                      {player.teamAbbrev} · performance {money(player.fairValue)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="tnum text-sm font-semibold text-ink-100">
                      {money(player.marketPrice)}
                    </div>
                    <div
                      className={`tnum text-xs ${
                        player.sharesOutstanding > 0 ? trendClass(premiumPct) : "text-ink-500"
                      }`}
                    >
                      {player.sharesOutstanding > 0 ? signedPct(premiumPct) : "at open"}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
                </>
              ) : (
                <EmptyState
                  title="You are not following anyone yet"
                  body="Star an athlete from their page to track them here without buying in."
                  action={<ButtonLink href="/">Browse the market</ButtonLink>}
                />
              ),
          },
          {
            id: "activity",
            label: "Activity",
            count: trades.length,
            content: <TradeHistory trades={trades} />,
          },
          {
            id: "news",
            label: "News",
            count: news.length,
            content: (
              <NewsList
                items={news}
                title="News on your athletes"
                emptyBody={
                  positions.length === 0
                    ? "Buy an athlete and stories about them will collect here."
                    : "No recent stories mention the athletes you hold."
                }
                playerNames={Object.fromEntries(
                  positions.map((p) => [p.player.id, p.player.fullName])
                )}
              />
            ),
          },
        ]}
      />
    </div>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink-50">Portfolio</h1>
      <p className="mt-1.5 text-sm text-ink-400">Your cash, positions, and profit and loss.</p>
    </header>
  );
}

import Link from "next/link";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { getLeaderboard } from "@/lib/market/portfolio";
import { money, signedMoney, trendClass } from "@/lib/format";
import { ButtonLink, Card, EmptyState } from "@/components/ui";
import { isBotUsername } from "@/lib/bots/identity";

/** Everyone starts here, so profit is net worth measured against the same line. */
const STARTING_CASH = 100_000;

export default async function LeaderboardPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="rise">
        <Header />
        <EmptyState
          title="Rankings need a database"
          body="The leaderboard compares every trader's net worth, which requires accounts."
          action={<ButtonLink href="/">Browse the market</ButtonLink>}
        />
      </div>
    );
  }

  const rows = await getLeaderboard();

  if (rows.length === 0) {
    return (
      <div className="rise">
        <Header />
        <EmptyState
          title="Sign in to see the rankings"
          body="Traders are ranked by net worth — cash plus the market value of everything they hold."
          action={<ButtonLink href="/login">Sign in</ButtonLink>}
        />
      </div>
    );
  }

  return (
    <div className="rise">
      <Header />

      <Card className="overflow-hidden">
        <div className="hidden grid-cols-[48px_1fr_110px_110px_120px] items-center gap-3 border-b border-ink-750 bg-ink-875 px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400 sm:grid">
          <div>#</div>
          <div>Trader</div>
          <div className="text-right">Positions</div>
          <div className="text-right">Holdings</div>
          <div className="text-right">Net worth</div>
        </div>

        <ul className="divide-y divide-ink-800">
          {rows.map((r) => {
            const profit = r.netWorth - STARTING_CASH;
            return (
              <li
                key={r.id}
                className={`grid grid-cols-[36px_1fr_auto] items-center gap-3 px-4 py-3 sm:grid-cols-[48px_1fr_110px_110px_120px] ${
                  r.isYou ? "bg-accent-dim/40" : ""
                }`}
              >
                <div
                  className={`tnum text-sm font-bold ${
                    r.rank <= 3 ? "text-up" : "text-ink-400"
                  }`}
                >
                  {r.rank}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-ink-50">
                      {r.username}
                    </span>
                    {r.isYou && (
                      <span className="rounded bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-950">
                        you
                      </span>
                    )}
                    {/* Labelled, always. Nobody should wonder whether the
                        account beating them is a person. */}
                    {isBotUsername(r.username) && (
                      <Link
                        href={`/trader/${encodeURIComponent(r.username)}`}
                        className="rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-bold uppercase text-ink-300 transition-colors hover:bg-ink-600 hover:text-ink-100"
                        title={`See what ${r.username} is holding`}
                      >
                        bot · positions
                      </Link>
                    )}
                  </div>
                  <div className={`tnum mt-0.5 text-xs ${trendClass(profit)}`}>
                    {signedMoney(profit)} all time
                  </div>
                </div>

                <div className="tnum hidden text-right text-sm text-ink-300 sm:block">
                  {r.positionCount}
                </div>
                <div className="tnum hidden text-right text-sm text-ink-300 sm:block">
                  {money(r.holdingsValue)}
                </div>

                <div className="tnum text-right text-sm font-semibold text-ink-50">
                  {money(r.netWorth)}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <p className="mt-3 text-xs text-ink-400">
        Net worth is cash plus the market value of every position. For people, only usernames and
        net worth are shared — nobody can see what another trader holds, and the database enforces
        that rather than the interface. Accounts marked{" "}
        <span className="rounded bg-ink-700 px-1 py-0.5 text-[10px] font-bold uppercase text-ink-300">
          bot
        </span>{" "}
        are automated traders that buy and sell every day to keep the market moving. They follow the
        same rules everyone else does — same position limits, same prices, no special access — and
        because they are not people, you can click one to see exactly what it is holding.
      </p>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink-50">Leaderboard</h1>
      <p className="mt-1.5 text-sm text-ink-400">
        Every trader ranked by what their portfolio is worth right now.
      </p>
    </header>
  );
}

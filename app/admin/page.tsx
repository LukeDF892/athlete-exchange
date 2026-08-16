import Link from "next/link";
import { isAdmin, getAdminOverview, getAdminTrades } from "@/lib/market/admin";
import { getLeaderboard } from "@/lib/market/portfolio";
import { money } from "@/lib/format";
import { ButtonLink, Card, EmptyState, StatTile } from "@/components/ui";
import { RetirementControl } from "@/components/RetirementControl";

/**
 * Operator view.
 *
 * Read-only by construction — see lib/market/admin.ts. It exists so the person
 * running the exchange can tell whether it is actually being used, and spot a
 * price or a position that looks wrong, without having to open the database.
 */
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  if (!(await isAdmin())) {
    return (
      <div className="rise">
        <EmptyState
          title="Operator access only"
          body="This page is for the account that runs the exchange. What an operator can see — and the fact that they cannot alter balances, trades or prices — is set out in the terms."
          action={<ButtonLink href="/terms">Read the terms</ButtonLink>}
        />
      </div>
    );
  }

  const [overview, trades, leaders] = await Promise.all([
    getAdminOverview(),
    getAdminTrades(50),
    getLeaderboard(10),
  ]);

  return (
    <div className="rise">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-50">Operator</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
          Read-only with one exception: retirement, below. There is no path from this page to
          anyone&rsquo;s balance, and no way to edit a trade or set a price — an operator can end a
          listing, never change what it is worth or what someone owns. That boundary is what{" "}
          <Link href="/terms" className="text-accent underline-offset-2 hover:underline">
            the terms
          </Link>{" "}
          promise every trader.
        </p>
      </header>

      {overview && (
        <section className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <StatTile label="Traders" value={overview.traders.toLocaleString()} />
          <StatTile label="Trades" value={overview.tradesTotal.toLocaleString()} />
          <StatTile label="Today" value={overview.tradesToday.toLocaleString()} />
          <StatTile label="Cash held" value={money(overview.cashHeld)} />
          <StatTile label="Open positions" value={overview.positionsOpen.toLocaleString()} />
          <StatTile label="Follows" value={overview.watchlistRows.toLocaleString()} />
        </section>
      )}

      <div className="mb-5">
        <RetirementControl />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-ink-750 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-100">Recent trades</h2>
            <p className="mt-0.5 text-xs text-ink-400">Across every account, newest first.</p>
          </div>
          {trades.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-400">
              Nobody has traded yet.
            </p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {trades.map((t) => (
                <li
                  key={t.id}
                  className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <div className="truncate text-ink-100">
                      <span className="text-ink-300">{t.username}</span>{" "}
                      <span
                        className={`font-semibold ${t.side === "buy" ? "text-up" : "text-down"}`}
                      >
                        {t.side === "buy" ? "bought" : "sold"}
                      </span>{" "}
                      {t.shares.toLocaleString()} × {t.playerName}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-500">
                      {new Date(t.createdAt).toLocaleString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}{" "}
                      @ {money(t.avgPrice)}
                    </div>
                  </div>
                  <div className="tnum text-right text-sm font-semibold text-ink-100">
                    {money(t.net)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-ink-750 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-100">Top traders</h2>
            <p className="mt-0.5 text-xs text-ink-400">By net worth.</p>
          </div>
          {leaders.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-ink-400">No accounts yet.</p>
          ) : (
            <ul className="divide-y divide-ink-800">
              {leaders.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="tnum w-6 text-xs text-ink-500">{r.rank}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-100">{r.username}</span>
                  <span className="tnum text-ink-200">{money(r.netWorth)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

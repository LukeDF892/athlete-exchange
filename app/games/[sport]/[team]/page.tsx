import Link from "next/link";
import { notFound } from "next/navigation";
import { getTeamRoster } from "@/lib/market/roster";
import { fetchUpcoming } from "@/lib/providers/schedule";
import { UpcomingGames } from "@/components/UpcomingGames";
import { money, signedPct, trendClass } from "@/lib/format";
import { marketPremiumPct } from "@/lib/market/types";
import { Card, EmptyState, ButtonLink, PlayerAvatar, SportBadge, StatTile } from "@/components/ui";
import type { Sport } from "@/lib/pricing/engine";

const SPORTS = ["nba", "nhl", "mlb", "nfl"] as const;

/**
 * One team: who plays for them, what they cost, and who is hurt.
 *
 * The injury list leads rather than sitting in the table, because it is the
 * part that changes a decision — a fixture against a side missing its best
 * player is a different trade from the same fixture at full strength.
 */
export const dynamic = "force-dynamic";

export default async function TeamPage(props: PageProps<"/games/[sport]/[team]">) {
  const { sport, team } = await props.params;
  if (!SPORTS.includes(sport as (typeof SPORTS)[number])) notFound();

  const abbrev = decodeURIComponent(team);
  const [roster, fixtures] = await Promise.all([
    getTeamRoster(sport as Sport, abbrev),
    fetchUpcoming(sport as Sport, abbrev),
  ]);

  if (!roster) {
    return (
      <div className="rise">
        <EmptyState
          title={`No listed players for ${abbrev}`}
          body="Either this team is not in the market yet, or its roster has not been ingested. Prospects and unlisted positions do not appear here."
          action={<ButtonLink href="/games">Back to games</ButtonLink>}
        />
      </div>
    );
  }

  const total = roster.players.reduce((a, p) => a + p.marketPrice, 0);

  return (
    <div className="rise">
      <header className="mb-6">
        <Link href="/games" className="text-xs text-ink-400 hover:text-ink-200">
          ← Upcoming games
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight text-ink-50">
            {roster.teamName ?? roster.teamAbbrev}
          </h1>
          <SportBadge sport={sport as Sport} />
        </div>
      </header>

      <section className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatTile label="Listed players" value={String(roster.players.length)} />
        <StatTile label="Injured" value={String(roster.injured.length)} />
        <StatTile label="Roster value" value={money(total)} />
      </section>

      <Card className="mb-5 p-4">
        <h2 className="mb-2.5 text-sm font-semibold text-ink-100">Next games</h2>
        <UpcomingGames fixtures={fixtures} />
      </Card>

      {roster.injured.length > 0 && (
        <Card className="mb-5 overflow-hidden border-down/25">
          <div className="border-b border-ink-750 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-100">
              Injured ({roster.injured.length})
            </h2>
            <p className="mt-0.5 text-xs text-ink-400">
              Their prices already carry the discount — this is what the market has priced in.
            </p>
          </div>
          <ul className="divide-y divide-ink-800">
            {roster.injured.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/player/${p.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-850"
                >
                  <PlayerAvatar name={p.fullName} src={p.headshotUrl} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-ink-100">{p.fullName}</div>
                    <div className="truncate text-xs text-down">{p.injury?.summary}</div>
                  </div>
                  <div className="text-right">
                    <div className="tnum text-sm text-ink-100">{money(p.marketPrice)}</div>
                    <div className="tnum text-xs text-down">
                      {signedPct((p.injury!.multiplier - 1) * 100)}
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="border-b border-ink-750 px-4 py-3">
          <h2 className="text-sm font-semibold text-ink-100">Squad</h2>
          <p className="mt-0.5 text-xs text-ink-400">Most valuable first.</p>
        </div>
        <ul className="divide-y divide-ink-800">
          {roster.players.map((p) => {
            const premium = marketPremiumPct(p);
            return (
              <li key={p.id}>
                <Link
                  href={`/player/${p.id}`}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-ink-850"
                >
                  <PlayerAvatar name={p.fullName} src={p.headshotUrl} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink-100">
                        {p.fullName}
                      </span>
                      {p.injury && (
                        <span className="rounded bg-down-dim px-1.5 py-0.5 text-[9px] font-bold uppercase text-down">
                          {p.injury.status}
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-ink-500">
                      {[p.position, p.ageYears ? `${p.ageYears}y` : null].filter(Boolean).join(" · ")}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="tnum text-sm text-ink-100">{money(p.marketPrice)}</div>
                    <div
                      className={`tnum text-xs ${
                        p.sharesOutstanding > 0 ? trendClass(premium) : "text-ink-600"
                      }`}
                    >
                      {p.sharesOutstanding > 0 ? signedPct(premium) : "at open"}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

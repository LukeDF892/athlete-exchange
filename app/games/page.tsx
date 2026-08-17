import Link from "next/link";
import { fetchSchedule } from "@/lib/providers/scoreboard";
import { Card, EmptyState, ButtonLink, SportBadge } from "@/components/ui";

/**
 * What is on, and who is playing.
 *
 * The market answers "what is this athlete worth"; this answers "who is about
 * to play", which is the question that comes first. Every team links through to
 * its listed players so a fixture can be turned into a trade in one step.
 */
export const dynamic = "force-dynamic";

export default async function GamesPage() {
  const games = await fetchSchedule(4);

  if (games.length === 0) {
    return (
      <div className="rise">
        <Header />
        <EmptyState
          title="Nothing scheduled"
          body="No games in the next few days across any of the four leagues — which happens between seasons. Prices still move on the market, but nothing new will change performance values until play resumes."
          action={<ButtonLink href="/">Browse the market</ButtonLink>}
        />
      </div>
    );
  }

  // Grouped by calendar day in the reader's most likely frame, not UTC.
  const byDay = new Map<string, typeof games>();
  for (const g of games) {
    const key = new Date(g.date).toLocaleDateString("en-US", {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    const list = byDay.get(key);
    if (list) list.push(g);
    else byDay.set(key, [g]);
  }

  return (
    <div className="rise">
      <Header />
      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-ink-100">
            {day} <span className="font-normal text-ink-500">· {list.length} games</span>
          </h2>
          <Card className="overflow-hidden">
            <ul className="divide-y divide-ink-800">
              {list.map((g) => (
                <li
                  key={`${g.sport}-${g.id}`}
                  className="flex items-center gap-3 px-4 py-3 text-sm"
                >
                  <SportBadge sport={g.sport} />
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                    {g.away ? (
                      <Link
                        href={`/games/${g.sport}/${encodeURIComponent(g.away.abbrev)}`}
                        className="font-medium text-ink-100 underline-offset-2 hover:text-accent hover:underline"
                      >
                        {g.away.abbrev}
                      </Link>
                    ) : (
                      <span className="text-ink-500">TBD</span>
                    )}
                    <span className="text-xs text-ink-500">at</span>
                    {g.home ? (
                      <Link
                        href={`/games/${g.sport}/${encodeURIComponent(g.home.abbrev)}`}
                        className="font-medium text-ink-100 underline-offset-2 hover:text-accent hover:underline"
                      >
                        {g.home.abbrev}
                      </Link>
                    ) : (
                      <span className="text-ink-500">TBD</span>
                    )}
                  </div>
                  <span className="shrink-0 text-xs text-ink-400">
                    {new Date(g.date).toLocaleTimeString("en-US", {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ))}
      <p className="text-xs text-ink-500">
        Tap a team to see its listed players and who is hurt. Performance values update after each
        game.
      </p>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink-50">Upcoming games</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
        The next few days across all four leagues. Tap a team to see who plays for them, what they
        cost, and who is injured.
      </p>
    </header>
  );
}

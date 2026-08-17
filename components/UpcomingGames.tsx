import type { Fixture } from "@/lib/providers/schedule";

/**
 * The next few games, as a strip you can read at a glance.
 *
 * Deliberately not a table. The question this answers is "is there anything
 * coming up worth buying before?", which is about *how many* games and *how
 * soon* — both of which read faster as a row of cards than as rows of dates.
 *
 * Days-away is shown rather than only the date, because "in 2 days" is the
 * form the decision is actually made in.
 */
export function UpcomingGames({ fixtures }: { fixtures: Fixture[] }) {
  if (fixtures.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-ink-400">
        No scheduled games — either the season has not started or this listing has no fixtures.
        Prices still move on the market, but nothing new will change their performance value.
      </p>
    );
  }

  const now = Date.now();

  return (
    <div>
      <ul className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {fixtures.map((f) => {
          const when = new Date(f.date);
          const days = Math.round((when.getTime() - now) / 86_400_000);
          const soon = days <= 1;

          return (
            <li
              key={f.date + (f.opponent ?? "")}
              className={`shrink-0 rounded-lg border px-3 py-2 ${
                soon ? "border-accent/40 bg-accent/10" : "border-ink-750 bg-ink-850/60"
              }`}
            >
              <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                {when.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
              </div>
              <div className="mt-0.5 whitespace-nowrap text-sm font-medium text-ink-100">
                <span className="text-ink-500">{f.homeAway === "away" ? "@" : "vs"}</span>{" "}
                {f.opponent ?? "TBD"}
              </div>
              <div className="mt-0.5 text-[10px] text-ink-500">
                {days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs text-ink-500">
        {fixtures.length} upcoming {fixtures.length === 1 ? "game" : "games"} · performance value
        updates after each one
      </p>
    </div>
  );
}

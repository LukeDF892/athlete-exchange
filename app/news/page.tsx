import { getNews, getPlayers } from "@/lib/market/source";
import { getPortfolio, getWatchlistIds } from "@/lib/market/portfolio";
import { EmptyState } from "@/components/ui";
import { NewsFilter } from "@/components/NewsFilter";

export default async function NewsPage() {
  const [news, players, portfolio, watchedPlayerIds] = await Promise.all([
    getNews(),
    getPlayers(),
    getPortfolio(),
    getWatchlistIds(),
  ]);
  const heldPlayerIds = portfolio?.positions.map((p) => p.player.id) ?? [];

  if (news.length === 0) {
    return (
      <EmptyState
        title="No headlines yet"
        body="Run `npm run ingest` to pull the latest NBA and NHL news and tag it to the athletes it mentions."
      />
    );
  }

  const nameById = new Map(players.map((p) => [p.id, p.fullName]));
  // Precomputed once here rather than per keystroke in the browser: searching
  // "Oilers" should find McDavid stories even when the headline never says it.
  const searchById = new Map(
    players.map((p) => [
      p.id,
      [p.fullName, p.teamName, p.teamAbbrev, p.position].filter(Boolean).join(" ").toLowerCase(),
    ])
  );

  return (
    <div className="rise">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-50">News</h1>
        <p className="mt-1.5 text-sm text-ink-400">
          Headlines that move prices. Stories mentioning a listed athlete are linked to them.
        </p>
      </header>

      <NewsFilter
        items={news.map((n) => ({
          ...n,
          playerNames: n.playerIds
            .map((id) => ({ id, name: nameById.get(id) }))
            .filter((p): p is { id: string; name: string } => Boolean(p.name)),
          searchText: n.playerIds.map((id) => searchById.get(id) ?? "").join(" "),
        }))}
      />
    </div>
  );
}

import { getPlayers, getNews } from "@/lib/market/source";
import { MarketBoard } from "@/components/MarketBoard";
import { TradeTape } from "@/components/TradeTape";
import { GettingStarted } from "@/components/GettingStarted";
import { getTradeTape } from "@/lib/market/tape";
import { isSignedIn } from "@/lib/market/portfolio";
import { EmptyState, StatTile } from "@/components/ui";
import { money, signedPct } from "@/lib/format";
import { marketIndexPct, toMarketRow } from "@/lib/market/types";
import { getPriceChanges, getPriceTrends, CHANGE_WINDOWS, type ChangeWindow } from "@/lib/market/changes";
import type { Player } from "@/lib/market/types";

export default async function MarketPage(props: PageProps<"/">) {
  const params = await props.searchParams;
  const requested = Array.isArray(params.change) ? params.change[0] : params.change;
  const changeWindow: ChangeWindow = CHANGE_WINDOWS.includes(requested as ChangeWindow)
    ? (requested as ChangeWindow)
    : "1D";

  const [players, news] = await Promise.all([getPlayers(), getNews()]);

  if (players.length === 0) {
    return (
      <EmptyState
        title="The exchange has not been stocked yet"
        body="Run `npm run ingest` to pull live NBA and NHL rosters, price every athlete from their real career production, and open the market."
      />
    );
  }

  // Sparkline series for every row, built on the server so the client ships
  // numbers rather than a chart engine. These are career value by season — real
  // history — rather than the modeled price walk they used to show, which drew
  // a confident trend line for athletes nobody had ever traded.
  /**
   * The trend column follows the selected window.
   *
   * "career" is the one window where a season-by-season arc is the right shape;
   * every other window wants actual price ticks from that period. A listing with
   * no ticks in the window gets no sparkline, which is honest — it has not
   * traded — rather than a career shape standing in for one.
   */
  const trends: Record<string, number[]> =
    changeWindow === "career"
      ? {}
      : await getPriceTrends(changeWindow);
  const careerTrends: Record<string, number[]> = {};
  for (const p of players) {
    careerTrends[p.id] = p.careerValue.map((c) => c.value);
  }

  const totalCap = players.reduce((a, p) => a + p.marketPrice * p.liquidityDepth * 0.01, 0);
  const nba = players.filter((p) => p.sport === "nba").length;
  const nhl = players.filter((p) => p.sport === "nhl").length;
  // Written before baseball existed, and left saying "565 NBA · 905 NHL" while
  // MLB quietly made up the majority of the board.
  const mlb = players.filter((p) => p.sport === "mlb").length;
  const nfl = players.filter((p) => p.sport === "nfl").length;
  const priciest = [...players].sort((a, b) => b.marketPrice - a.marketPrice)[0] as Player;
  const [changes, tape, signedIn] = await Promise.all([
    getPriceChanges(players, changeWindow),
    getTradeTape(12),
    isSignedIn(),
  ]);
  const indexPct = marketIndexPct(players);
  const tradedCount = players.filter((p) => p.sharesOutstanding > 0).length;

  return (
    <div className="rise">
      <section className="mb-7">
        <h1 className="text-2xl font-bold tracking-tight text-ink-50 sm:text-3xl">
          The stock market for athletes
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-300">
          Every athlete opens at a price derived from their real career production. From there the
          market takes over — each share bought pushes the price up, each share sold pushes it down.
          Hold a career, not a bet.
        </p>
      </section>

      {!signedIn && <GettingStarted />}

      <section className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Listed athletes"
          value={String(players.length)}
          hint={`${nfl} NFL · ${nba} NBA · ${nhl} NHL · ${mlb} MLB`}
        />
        <StatTile label="Market cap" value={money(totalCap, { compact: true })} hint="notional" />
        <StatTile
          label="Most valuable"
          value={money(priciest.marketPrice)}
          hint={priciest.fullName}
          tone="accent"
        />
        <StatTile
          label="Market index"
          value={tradedCount === 0 ? "—" : signedPct(indexPct)}
          hint={
            tradedCount === 0
              ? "nothing traded yet"
              : `avg premium across ${tradedCount} traded`
          }
          tone={indexPct > 0 ? "up" : indexPct < 0 ? "down" : "neutral"}
        />
      </section>

      <TradeTape entries={tape} />

      <MarketBoard
        players={players.map(toMarketRow)}
        trends={changeWindow === "career" ? careerTrends : trends}
        indexPct={indexPct}
        changes={changes}
        changeWindow={changeWindow}
      />
    </div>
  );
}

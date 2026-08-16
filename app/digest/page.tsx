import Link from "next/link";
import { getPlayers } from "@/lib/market/source";
import { getDigest, getPersonalDigest, type Mover, type PersonalDigest } from "@/lib/market/digest";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { ButtonLink, Card, EmptyState, PlayerAvatar, SportBadge } from "@/components/ui";

/**
 * The day's movement.
 *
 * Split into performance and market movement, because those mean opposite
 * things: one says the athlete changed, the other says opinion about them did.
 */
export const dynamic = "force-dynamic";

export default async function DigestPage() {
  const players = await getPlayers();
  const [digest, personal] = await Promise.all([
    getDigest(players),
    getPersonalDigest(players),
  ]);
  const hasPersonal =
    personal != null &&
    (personal.holdings.length > 0 || personal.watching.length > 0 || personal.retiring.length > 0);

  if (!digest.hasHistory) {
    return (
      <div className="rise">
        <Header since={null} />
        <EmptyState
          title="No movement recorded yet"
          body="Prices are re-derived from live production once a day. The first comparison appears after two refreshes — and price history is only readable once you are signed in."
          action={<ButtonLink href="/">Browse the market</ButtonLink>}
        />
      </div>
    );
  }

  const nothingMoved =
    digest.performance.up.length === 0 &&
    digest.performance.down.length === 0 &&
    digest.market.up.length === 0 &&
    digest.market.down.length === 0;

  return (
    <div className="rise">
      <Header since={digest.since} />

      {/* Your own money first — the market-wide lists are context for it. */}
      {hasPersonal && <YourDay personal={personal!} />}

      {nothingMoved ? (
        <EmptyState
          title="Nothing moved"
          body="No listing's performance value or market price changed since the last refresh. On an off-day across all three leagues, that is the honest answer."
          action={<ButtonLink href="/">Browse the market</ButtonLink>}
        />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <MoverCard
            title="Performance gainers"
            hint="Played better, so they are worth more."
            movers={digest.performance.up}
            metric="performance"
          />
          <MoverCard
            title="Performance fallers"
            hint="Production dropped, or an injury was reported."
            movers={digest.performance.down}
            metric="performance"
          />
          <MoverCard
            title="Bought up"
            hint="Traders pushed the price above what production changed."
            movers={digest.market.up}
            metric="price"
          />
          <MoverCard
            title="Sold off"
            hint="The price fell while the athlete's fundamentals held."
            movers={digest.market.down}
            metric="price"
          />
        </div>
      )}

      {digest.injured.length > 0 && (
        <Card className="mt-5 overflow-hidden">
          <div className="border-b border-ink-750 px-4 py-3">
            <h2 className="text-sm font-semibold text-ink-100">Currently discounted for injury</h2>
            <p className="mt-0.5 text-xs text-ink-400">
              Fair value is marked down from what their production alone would justify.
            </p>
          </div>
          <ul className="divide-y divide-ink-800">
            {digest.injured.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/player/${p.id}`}
                  className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
                >
                  <PlayerAvatar name={p.fullName} src={p.headshotUrl} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-ink-100">{p.fullName}</span>
                      <SportBadge sport={p.sport} />
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-400">{p.injury?.summary}</div>
                  </div>
                  <div className="text-right">
                    <div className="tnum text-sm font-semibold text-ink-100">
                      {money(p.fairValue)}
                    </div>
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
    </div>
  );
}

/**
 * Movement in what you actually own.
 *
 * Ranked by cash effect, not percentage: a 2% move on a big position is worth
 * more attention than a 30% move on a single share.
 */
function YourDay({ personal }: { personal: PersonalDigest }) {
  const net = personal.holdings.reduce((a, h) => a + h.valueChange, 0);

  return (
    <Card className="mb-5 overflow-hidden border-accent/25">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink-750 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Your day</h2>
          <p className="mt-0.5 text-xs text-ink-400">
            Movement in the listings you hold and follow.
          </p>
        </div>
        {personal.holdings.length > 0 && (
          <span className={`tnum text-sm font-bold ${trendClass(net)}`}>
            {signedMoney(net)} across your positions
          </span>
        )}
      </div>

      {personal.retiring.length > 0 && (
        <div className="border-b border-ink-750 bg-warn-dim/40 px-4 py-2.5">
          {personal.retiring.map((p) => (
            <p key={p.id} className="text-xs text-ink-100">
              <Link href={`/player/${p.id}`} className="font-semibold underline-offset-2 hover:underline">
                {p.fullName}
              </Link>{" "}
              is retiring
              {p.settlesAt && <> — settles {new Date(p.settlesAt).toLocaleDateString()}</>}. You will
              be bought out in cash automatically.
            </p>
          ))}
        </div>
      )}

      {personal.holdings.length > 0 && (
        <ul className="divide-y divide-ink-800">
          {personal.holdings.map((h) => (
            <li key={h.player.id}>
              <Link
                href={`/player/${h.player.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
              >
                <PlayerAvatar name={h.player.fullName} src={h.player.headshotUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">
                      {h.player.fullName}
                    </span>
                    <SportBadge sport={h.player.sport} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-400">
                    {h.shares.toLocaleString()} shares · {money(h.from)} → {money(h.to)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`tnum text-sm font-semibold ${trendClass(h.valueChange)}`}>
                    {signedMoney(h.valueChange)}
                  </div>
                  <div className={`tnum text-xs ${trendClass(h.abs)}`}>{signedPct(h.pct)}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {personal.watching.length > 0 && (
        <div className="border-t border-ink-800 px-4 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Following
          </p>
          <ul className="mt-1 space-y-0.5">
            {personal.watching.map((m) => (
              <li key={m.player.id} className="flex items-baseline justify-between gap-3 text-xs">
                <Link
                  href={`/player/${m.player.id}`}
                  className="truncate text-ink-200 underline-offset-2 hover:underline"
                >
                  {m.player.fullName}
                </Link>
                <span className={`tnum ${trendClass(m.abs)}`}>{signedPct(m.pct)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function Header({ since }: { since: string | null }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight text-ink-50">Today</h1>
      <p className="mt-1.5 max-w-2xl text-sm text-ink-400">
        What changed, split by whether the athlete moved or the market did.
        {since && (
          <>
            {" "}Compared against{" "}
            {new Date(since).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
            .
          </>
        )}
      </p>
    </header>
  );
}

function MoverCard({
  title,
  hint,
  movers,
  metric,
}: {
  title: string;
  hint: string;
  movers: Mover[];
  metric: "performance" | "price";
}) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-750 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-400">{hint}</p>
      </div>
      {movers.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-ink-500">Nothing in this direction.</p>
      ) : (
        <ul className="divide-y divide-ink-800">
          {movers.map((m) => (
            <li key={m.player.id}>
              <Link
                href={`/player/${m.player.id}`}
                className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-ink-850"
              >
                <PlayerAvatar name={m.player.fullName} src={m.player.headshotUrl} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-ink-100">
                      {m.player.fullName}
                    </span>
                    <SportBadge sport={m.player.sport} />
                  </div>
                  <div className="mt-0.5 truncate text-xs text-ink-400">
                    {metric === "performance" ? "performance" : "price"} {money(m.from)} →{" "}
                    {money(m.to)}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`tnum text-sm font-semibold ${trendClass(m.abs)}`}>
                    {signedPct(m.pct)}
                  </div>
                  <div className={`tnum text-xs ${trendClass(m.abs)}`}>{signedMoney(m.abs)}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

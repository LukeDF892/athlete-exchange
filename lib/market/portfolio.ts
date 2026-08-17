import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Sport } from "@/lib/pricing/engine";
import type { NewsItem, Player } from "./types";
import { marketPremiumPct } from "./types";
import { getNews } from "./source";

export interface Position {
  player: Player;
  shares: number;
  avgCost: number;
  marketValue: number;
  costBasis: number;
  unrealizedPnl: number;
  unrealizedPct: number;
}

export interface PortfolioSummary {
  username: string;
  /** Whether this trader opted in to the daily email. */
  emailDigest: boolean;
  cash: number;
  positions: Position[];
  holdingsValue: number;
  netWorth: number;
  totalCostBasis: number;
  totalPnl: number;
  totalPnlPct: number;
}

/** What the trade panel needs to render: are we allowed to trade, and with what. */
export interface TradingContext {
  tradingEnabled: boolean;
  cash: number | null;
  sharesHeld: number;
  /** What the held shares cost on average — the basis a sale is measured against. */
  avgCost: number;
  blockedReason: "no-database" | "signed-out";
}

/** One executed trade, for the activity list. */
export interface TradeRecord {
  id: string;
  side: "buy" | "sell";
  shares: number;
  avgPrice: number;
  net: number;
  createdAt: string;
  playerId: string;
  playerName: string;
  playerSport: Sport;
  headshotUrl: string | null;
  /** Realized profit or loss on a sale; null for a purchase. */
  realized: number | null;
}

export async function getTradingContext(playerId: string): Promise<TradingContext> {
  const off = (blockedReason: "no-database" | "signed-out"): TradingContext => ({
    tradingEnabled: false,
    cash: null,
    sharesHeld: 0,
    avgCost: 0,
    blockedReason,
  });
  if (!isSupabaseConfigured()) return off("no-database");

  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return off("signed-out");

    const [{ data: profile }, { data: holding }] = await Promise.all([
      supabase.from("profiles").select("cash_balance").eq("id", user.id).maybeSingle(),
      supabase
        .from("holdings")
        .select("shares, avg_cost")
        .eq("user_id", user.id)
        .eq("player_id", playerId)
        .maybeSingle(),
    ]);

    return {
      tradingEnabled: true,
      cash: profile ? Number(profile.cash_balance) : 0,
      sharesHeld: holding ? Number(holding.shares) : 0,
      avgCost: holding ? Number(holding.avg_cost) : 0,
      blockedReason: "signed-out",
    };
  } catch {
    return off("signed-out");
  }
}

export async function getPortfolio(): Promise<PortfolioSummary | null> {
  if (!isSupabaseConfigured()) return null;

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [{ data: profile }, { data: holdings }] = await Promise.all([
    supabase.from("profiles").select("username, cash_balance").eq("id", user.id).maybeSingle(),
    supabase.from("holdings").select("shares, avg_cost, players(*)").eq("user_id", user.id),
  ]);

  const cash = profile ? Number(profile.cash_balance) : 0;

  const positions: Position[] = ((holdings ?? []) as unknown as Array<{
    shares: number;
    avg_cost: number;
    players: Record<string, unknown> | null;
  }>)
    .filter((h) => h.players)
    .map((h) => {
      const raw = h.players as Record<string, unknown>;
      const player: Player = {
        id: String(raw.id),
        externalId: String(raw.external_id),
        sport: raw.sport as Player["sport"],
        fullName: String(raw.full_name),
        firstName: String(raw.first_name ?? ""),
        lastName: String(raw.last_name ?? ""),
        position: (raw.position as string | null) ?? null,
        jersey: (raw.jersey as string | null) ?? null,
        teamAbbrev: (raw.team_abbrev as string | null) ?? null,
        teamName: (raw.team_name as string | null) ?? null,
        headshotUrl: (raw.headshot_url as string | null) ?? null,
        ageYears: raw.age_years == null ? null : Number(raw.age_years),
        isGoalie: Boolean(raw.is_goalie),
        fairValue: Number(raw.fair_value),
        openingFairValue: Number(raw.opening_fair_value),
        liquidityDepth: Number(raw.liquidity_depth),
        sharesOutstanding: Number(raw.shares_outstanding),
        marketPrice: Number(raw.market_price),
        prevClose: raw.prev_close == null ? null : Number(raw.prev_close),
        statTables: (raw.stat_tables as Player["statTables"]) ?? [],
        gameLog: (raw.game_log as Player["gameLog"]) ?? [],
        careerValue: (raw.career_value as Player["careerValue"]) ?? [],
        kind: (raw.kind as Player["kind"]) ?? "athlete",
        components: (raw.components as Player["components"]) ?? [],
        injury: (raw.injury as Player["injury"]) ?? null,
        healthyFairValue:
          raw.healthy_fair_value == null
            ? Number(raw.fair_value)
            : Number(raw.healthy_fair_value),
      };

      const shares = Number(h.shares);
      const avgCost = Number(h.avg_cost);
      /**
       * Negative shares are a short, and both numbers flip meaning.
       *
       * `marketValue` becomes what it would cost to buy the position back —
       * carried as a negative, so net worth is still cash plus the sum of
       * positions. `costBasis` is what you were paid to open it. Profit is
       * therefore still value minus basis, which for a short is positive when
       * the price has fallen: exactly the same arithmetic, no special case.
       */
      const marketValue = shares * player.marketPrice;
      const costBasis = shares * avgCost;

      return {
        player,
        shares,
        avgCost,
        marketValue,
        costBasis,
        unrealizedPnl: marketValue - costBasis,
        // Measured against the size of the position either way, so a short
        // does not report a negative percentage while making money.
        unrealizedPct:
          Math.abs(costBasis) > 0 ? ((marketValue - costBasis) / Math.abs(costBasis)) * 100 : 0,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue);

  const holdingsValue = positions.reduce((a, p) => a + p.marketValue, 0);
  const totalCostBasis = positions.reduce((a, p) => a + p.costBasis, 0);
  const totalPnl = holdingsValue - totalCostBasis;

  return {
    username: profile?.username ?? "trader",
    emailDigest: (user.user_metadata as Record<string, unknown> | null)?.email_digest === true,
    cash,
    positions,
    holdingsValue,
    netWorth: cash + holdingsValue,
    totalCostBasis,
    totalPnl,
    totalPnlPct: totalCostBasis > 0 ? (totalPnl / totalCostBasis) * 100 : 0,
  };
}

/** Whether there is an authenticated session, for chrome that adapts to it. */
export async function isSignedIn(): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    return Boolean(user);
  } catch {
    return false;
  }
}

/**
 * Executed trades, newest first.
 *
 * Realized profit and loss is computed here rather than stored, because the
 * trades table records what happened at the time (price, shares, proceeds) and
 * not what the position had cost. For a sale we reconstruct the cost basis by
 * walking that athlete's earlier buys, so "you made $40 on that sale" is a real
 * number rather than a guess.
 */
export async function getTrades(limit = 50, playerId?: string): Promise<TradeRecord[]> {
  if (!isSupabaseConfigured()) return [];

  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  let query = supabase
    .from("trades")
    .select("id, side, shares, avg_price, net, created_at, player_id, players(full_name, sport, headshot_url)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });
  if (playerId) query = query.eq("player_id", playerId);

  const { data, error } = await query;
  if (error || !data) return [];

  // Walk forward keeping a running average cost per athlete, so each sale can
  // be measured against what those specific shares actually cost.
  const basis = new Map<string, { shares: number; avgCost: number }>();
  const out: TradeRecord[] = [];

  for (const t of data as unknown as Array<{
    id: string;
    side: "buy" | "sell";
    shares: number;
    avg_price: number;
    net: number;
    created_at: string;
    player_id: string;
    players: { full_name: string; sport: Sport; headshot_url: string | null } | null;
  }>) {
    const shares = Number(t.shares);
    const avgPrice = Number(t.avg_price);
    const net = Number(t.net);
    const prev = basis.get(t.player_id) ?? { shares: 0, avgCost: 0 };

    let realized: number | null = null;
    if (t.side === "buy") {
      const total = prev.shares + shares;
      basis.set(t.player_id, {
        shares: total,
        avgCost: total > 0 ? (prev.shares * prev.avgCost + shares * avgPrice) / total : 0,
      });
    } else {
      realized = net - shares * prev.avgCost;
      basis.set(t.player_id, {
        shares: Math.max(0, prev.shares - shares),
        avgCost: prev.avgCost,
      });
    }

    out.push({
      id: String(t.id),
      side: t.side,
      shares,
      avgPrice,
      net,
      createdAt: t.created_at,
      playerId: t.player_id,
      playerName: t.players?.full_name ?? "Unknown",
      playerSport: t.players?.sport ?? "nba",
      headshotUrl: t.players?.headshot_url ?? null,
      realized,
    });
  }

  return out.reverse().slice(0, limit);
}

/**
 * News about athletes you actually hold.
 *
 * The news page carries every story; this narrows it to your positions, which
 * is the version that matters when you are deciding whether to sell.
 */
export async function getPortfolioNews(limit = 25): Promise<NewsItem[]> {
  const portfolio = await getPortfolio();
  if (!portfolio || portfolio.positions.length === 0) return [];

  const held = new Set(portfolio.positions.map((p) => p.player.id));
  const news = await getNews();
  return news.filter((n) => n.playerIds.some((id) => held.has(id))).slice(0, limit);
}

/** Player ids the signed-in user is following. */
export async function getWatchlistIds(): Promise<string[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data } = await supabase
      .from("watchlist")
      .select("player_id")
      .eq("user_id", user.id);
    return (data ?? []).map((r) => String(r.player_id));
  } catch {
    return [];
  }
}

/** Followed athletes with their current prices, for the watchlist section. */
export async function getWatchlist(): Promise<Array<{ player: Player; premiumPct: number }>> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data } = await supabase
      .from("watchlist")
      .select("players(*)")
      .eq("user_id", user.id);

    return ((data ?? []) as unknown as Array<{ players: Record<string, unknown> | null }>)
      .filter((r) => r.players)
      .map((r) => {
        const raw = r.players as Record<string, unknown>;
        const player = rowToPlayerLike(raw);
        return { player, premiumPct: marketPremiumPct(player) };
      })
      .sort((a, b) => b.player.marketPrice - a.player.marketPrice);
  } catch {
    return [];
  }
}

/** Shared mapping from a players row to the app's Player shape. */
function rowToPlayerLike(raw: Record<string, unknown>): Player {
  return {
    id: String(raw.id),
    externalId: String(raw.external_id),
    sport: raw.sport as Player["sport"],
    fullName: String(raw.full_name),
    firstName: String(raw.first_name ?? ""),
    lastName: String(raw.last_name ?? ""),
    position: (raw.position as string | null) ?? null,
    jersey: (raw.jersey as string | null) ?? null,
    teamAbbrev: (raw.team_abbrev as string | null) ?? null,
    teamName: (raw.team_name as string | null) ?? null,
    headshotUrl: (raw.headshot_url as string | null) ?? null,
    ageYears: raw.age_years == null ? null : Number(raw.age_years),
    isGoalie: Boolean(raw.is_goalie),
    fairValue: Number(raw.fair_value),
    openingFairValue: Number(raw.opening_fair_value),
    liquidityDepth: Number(raw.liquidity_depth),
    sharesOutstanding: Number(raw.shares_outstanding),
    marketPrice: Number(raw.market_price),
    prevClose: raw.prev_close == null ? null : Number(raw.prev_close),
    statTables: (raw.stat_tables as Player["statTables"]) ?? [],
    gameLog: (raw.game_log as Player["gameLog"]) ?? [],
    careerValue: (raw.career_value as Player["careerValue"]) ?? [],
    kind: (raw.kind as Player["kind"]) ?? "athlete",
    components: (raw.components as Player["components"]) ?? [],
    injury: (raw.injury as Player["injury"]) ?? null,
    healthyFairValue:
      raw.healthy_fair_value == null ? Number(raw.fair_value) : Number(raw.healthy_fair_value),
  };
}

export interface LeaderboardRow {
  id: string;
  username: string;
  netWorth: number;
  holdingsValue: number;
  positionCount: number;
  isYou: boolean;
  rank: number;
}

/**
 * Every trader ranked by net worth.
 *
 * Reads the leaderboard view, which runs with security_invoker = false so it
 * can aggregate across all profiles while the profiles table itself stays
 * self-access only. That is the whole point of the view: usernames and net
 * worth are public to signed-in users, cash and individual positions are not.
 */
export async function getLeaderboard(limit = 100): Promise<LeaderboardRow[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data, error } = await supabase
      .from("leaderboard")
      .select("id, username, net_worth, holdings_value, position_count")
      .order("net_worth", { ascending: false })
      .limit(limit);
    if (error || !data) return [];

    return data.map((r, i) => ({
      id: String(r.id),
      username: (r.username as string) ?? "trader",
      netWorth: Number(r.net_worth),
      holdingsValue: Number(r.holdings_value),
      positionCount: Number(r.position_count),
      isYou: String(r.id) === user.id,
      rank: i + 1,
    }));
  } catch {
    return [];
  }
}

export interface PortfolioPoint {
  ts: string;
  cash: number;
  holdingsValue: number;
  netWorth: number;
}

/**
 * Net worth over time.
 *
 * Written by the daily job rather than derived on read, because reconstructing
 * it would mean replaying every trade against the prices that applied at the
 * time — and those prices move. A recorded snapshot is what the portfolio was
 * actually worth that day, which is the only honest version of this chart.
 */
export async function getPortfolioHistory(limit = 90): Promise<PortfolioPoint[]> {
  if (!isSupabaseConfigured()) return [];
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return [];

    const { data } = await supabase
      .from("portfolio_snapshots")
      .select("ts, cash, holdings_value, net_worth")
      .eq("user_id", user.id)
      .order("ts", { ascending: true })
      .limit(limit);

    return (data ?? []).map((r) => ({
      ts: r.ts as string,
      cash: Number(r.cash),
      holdingsValue: Number(r.holdings_value),
      netWorth: Number(r.net_worth),
    }));
  } catch {
    return [];
  }
}

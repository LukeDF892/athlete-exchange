import type { Sport } from "@/lib/pricing/engine";
import type { StatTable, GameLogEntry } from "@/lib/providers/types";

/**
 * What an athlete would have been worth at the end of each season they played.
 *
 * A newly listed athlete has no trading history — nobody has bought or sold
 * them yet — but they always have a career. This is that career expressed in
 * the same dollars the market uses, so there is something real to look at from
 * day one instead of a flat line.
 */
export interface CareerValuePoint {
  year: number;
  /** "2025-26" */
  label: string;
  teamAbbrev: string | null;
  /** Fair value implied by that season's production, at that season's age. */
  value: number;
  gamesPlayed: number;
  /** Headline stat for the tooltip, e.g. "27.7 PPG" or "48G 90A". */
  summary: string;
}

export type ListingKind = "athlete" | "team" | "prospect";

export interface TeamComponent {
  playerId: string;
  fullName: string;
  position: string | null;
  fairValue: number;
  /** Share of the index this athlete accounts for. */
  weightPct: number;
  injured: boolean;
}

export interface Player {
  id: string;
  externalId: string;
  /** Athletes and teams share one table and one bonding curve. */
  kind: ListingKind;
  sport: Sport;
  fullName: string;
  firstName: string;
  lastName: string;
  position: string | null;
  jersey: string | null;
  teamAbbrev: string | null;
  teamName: string | null;
  headshotUrl: string | null;
  ageYears: number | null;
  isGoalie: boolean;
  fairValue: number;
  openingFairValue: number;
  liquidityDepth: number;
  sharesOutstanding: number;
  marketPrice: number;
  prevClose: number | null;
  statTables: StatTable[];
  gameLog: GameLogEntry[];
  /** Season-by-season value since their rookie year, oldest first. */
  careerValue: CareerValuePoint[];
  /** Current injury, when the feed reports one. Null means available. */
  injury: PlayerInjury | null;
  /** Fair value before any injury discount, so the markdown is showable. */
  healthyFairValue: number;
  /** For a team listing: the athletes it tracks, heaviest first. */
  components?: TeamComponent[];
  /** For a prospect: where they were drafted, which is what sets their price. */
  draft?: DraftInfo;
  /** Lifecycle. A retiring listing still trades; a settled one does not. */
  status?: ListingStatus;
  settlesAt?: string | null;
  settlementPrice?: number | null;
}

export type ListingStatus = "active" | "retiring" | "settled";

export interface DraftInfo {
  year: number;
  round: number;
  overallPick: number;
  amateurClub: string | null;
  amateurLeague: string | null;
}

export interface PlayerInjury {
  status: string;
  summary: string;
  returnDate: string | null;
  daysOut: number | null;
  /** Multiplier already applied to fairValue. 0.85 = priced 15% down. */
  multiplier: number;
}

export interface PriceTick {
  ts: string;
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string | null;
  imageUrl: string | null;
  publishedAt: string;
  sport: Sport | null;
  playerIds: string[];
}

export interface Holding {
  playerId: string;
  shares: number;
  avgCost: number;
}

export interface Portfolio {
  cash: number;
  holdings: Holding[];
}

/** Percent change of market price against the previous close. */
export function dayChangePct(player: Player): number | null {
  if (player.prevClose == null || player.prevClose <= 0) return null;
  return ((player.marketPrice - player.prevClose) / player.prevClose) * 100;
}

/** How far the crowd has pushed price away from pure performance. */
/**
 * The subset of a player the market board actually renders.
 *
 * The board lists every rostered athlete, and a full Player carries stat
 * tables, a game log and a whole career of value points. Serializing all of
 * that for 1,280 players sent a 5.7 MB payload to the browser for a table that
 * shows eleven fields — most of it never read, and painful on a phone.
 */
export interface MarketRow {
  id: string;
  fullName: string;
  sport: Sport;
  position: string | null;
  teamAbbrev: string | null;
  teamName: string | null;
  headshotUrl: string | null;
  ageYears: number | null;
  fairValue: number;
  marketPrice: number;
  sharesOutstanding: number;
  /** Present when injured, so the board can flag it. */
  injuryStatus: string | null;
  kind: ListingKind;
  status: ListingStatus;
}

export function toMarketRow(p: Player): MarketRow {
  return {
    id: p.id,
    fullName: p.fullName,
    sport: p.sport,
    position: p.position,
    teamAbbrev: p.teamAbbrev,
    teamName: p.teamName,
    headshotUrl: p.headshotUrl,
    ageYears: p.ageYears,
    fairValue: p.fairValue,
    marketPrice: p.marketPrice,
    sharesOutstanding: p.sharesOutstanding,
    injuryStatus: p.injury?.status ?? null,
    kind: p.kind,
    status: p.status ?? "active",
  };
}

/**
 * The board-wide average premium — this market's equivalent of an index level.
 *
 * A bonding curve mints shares rather than matching a buyer to a seller, so net
 * buying lifts every athlete at once and the whole board drifts to a premium.
 * Judged against zero, that makes everyone look overvalued forever. Judged
 * against this, "expensive" means expensive *relative to the market*, which is
 * how the word is actually used.
 *
 * Only athletes that have traded count: an untouched listing sits exactly at
 * fair value and would otherwise drag the average toward zero and overstate how
 * hot the traded names are.
 */
export function marketIndexPct(
  players: Array<Pick<Player, "fairValue" | "marketPrice" | "sharesOutstanding">>
): number {
  const traded = players.filter((p) => p.sharesOutstanding > 0);
  if (traded.length === 0) return 0;
  return traded.reduce((a, p) => a + marketPremiumPct(p), 0) / traded.length;
}

export function marketPremiumPct(player: Pick<Player, "fairValue" | "marketPrice">): number {
  if (player.fairValue <= 0) return 0;
  return ((player.marketPrice - player.fairValue) / player.fairValue) * 100;
}

// ---------------------------------------------------------------------------
// Price change windows
//
// These live here, not beside getPriceChanges, because the market board is a
// client component: importing them from a module that also reaches for the
// Supabase server client pulled `next/headers` into the browser bundle and
// broke the build. Pure values belong on the client-safe side of the line.
// ---------------------------------------------------------------------------

export type ChangeWindow = "1D" | "1W" | "1M" | "1Y" | "career";

export const CHANGE_WINDOWS: ChangeWindow[] = ["1D", "1W", "1M", "1Y", "career"];

export const WINDOW_LABELS: Record<ChangeWindow, string> = {
  "1D": "1 day",
  "1W": "1 week",
  "1M": "1 month",
  "1Y": "1 year",
  career: "since rookie season",
};

export interface PriceChange {
  abs: number;
  pct: number;
}

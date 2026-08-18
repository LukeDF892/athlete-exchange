"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { positionValue } from "@/lib/pricing/engine";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { useLivePrices } from "@/components/useLivePrices";

/**
 * One listing's price, live.
 *
 * The market board has listened to `players` over a websocket for a while, but
 * the player page — the screen you are actually looking at while deciding
 * whether to buy — was server-rendered and stayed frozen at whatever the price
 * was when it loaded. A bot could trade the listing three times while you read
 * the page and nothing on it moved.
 *
 * Everything on the page that shows this listing's price shares one
 * subscription through this context, rather than each component opening its
 * own. The server-rendered numbers stay authoritative until the socket says
 * otherwise, so the page is correct before the websocket connects and stays
 * correct if it never does.
 */
export interface LiveQuote {
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
  /** Direction of the last change, for the flash. Null until something moves. */
  direction: "up" | "down" | null;
}

const LiveQuoteContext = createContext<LiveQuote | null>(null);

export function LivePlayerProvider({
  playerId,
  marketPrice,
  fairValue,
  sharesOutstanding,
  children,
}: {
  playerId: string;
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
  children: ReactNode;
}) {
  // Nothing to listen to without a database — the page still renders, from the
  // snapshot, exactly as it did before.
  const live = useLivePrices(isSupabaseConfigured(), playerId)[playerId];
  const quote: LiveQuote = {
    marketPrice: live?.marketPrice ?? marketPrice,
    fairValue: live?.fairValue ?? fairValue,
    sharesOutstanding: live?.sharesOutstanding ?? sharesOutstanding,
    direction: live?.direction ?? null,
  };
  return <LiveQuoteContext.Provider value={quote}>{children}</LiveQuoteContext.Provider>;
}

/**
 * The live quote, or the server-rendered fallback passed in.
 *
 * Falling back rather than throwing keeps these components usable outside the
 * provider — the fallback is the same shape and is what renders on the server
 * pass anyway.
 */
export function useLiveQuote(fallback: LiveQuote): LiveQuote {
  return useContext(LiveQuoteContext) ?? fallback;
}

/**
 * A brief tint when a number changes, so a price that moves while you are
 * looking at the page is something you *notice* rather than something you would
 * only catch by comparing against a memory of the old number.
 */
function useFlash(value: number, direction: "up" | "down" | null): string {
  const previous = useRef(value);
  const [flash, setFlash] = useState<string>("");

  useEffect(() => {
    if (previous.current === value) return;
    const dir = direction ?? (value > previous.current ? "up" : "down");
    previous.current = value;
    setFlash(dir === "up" ? "flash-up" : "flash-down");
    const id = setTimeout(() => setFlash(""), 900);
    return () => clearTimeout(id);
  }, [value, direction]);

  return flash;
}

/** The headline price and its gap to performance value. */
export function LivePlayerPrice({
  marketPrice,
  fairValue,
  sharesOutstanding,
}: {
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
}) {
  const quote = useLiveQuote({ marketPrice, fairValue, sharesOutstanding, direction: null });
  const flash = useFlash(quote.marketPrice, quote.direction);
  const premium =
    quote.fairValue > 0 ? ((quote.marketPrice - quote.fairValue) / quote.fairValue) * 100 : 0;
  const hasTraded = quote.sharesOutstanding > 0;

  return (
    <div className="text-right">
      <div className={`tnum rounded px-1 text-3xl font-bold text-ink-50 ${flash}`}>
        {money(quote.marketPrice)}
      </div>
      <div className={`text-sm font-medium ${hasTraded ? trendClass(premium) : "text-ink-400"}`}>
        {hasTraded ? (
          <span className="tnum">{signedPct(premium)} vs performance</span>
        ) : (
          "At opening price"
        )}
      </div>
    </div>
  );
}

/**
 * What you already hold in this athlete.
 *
 * Shown above the trade ticket rather than inside it, because it answers a
 * different question: the ticket is about what you are about to do, this is
 * about what you have already done.
 *
 * Share count and average cost are yours and only change when you trade, so
 * they stay server-rendered. The market value and the P&L are the market's, and
 * move whenever anyone trades this listing — which is the whole reason this is
 * a client component.
 */
export function YourPosition({
  shares,
  avgCost,
  marketPrice,
  fairValue,
  sharesOutstanding,
  liquidityDepth,
}: {
  shares: number;
  avgCost: number;
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
  liquidityDepth: number;
}) {
  const quote = useLiveQuote({ marketPrice, fairValue, sharesOutstanding, direction: null });
  // What closing this position would pay, not shares x spot — see
  // positionValue(). Recomputed live, because both inputs move when anyone
  // trades this listing.
  const value = positionValue(quote.fairValue, quote.sharesOutstanding, shares, liquidityDepth);
  const flash = useFlash(quote.marketPrice, quote.direction);
  const basis = shares * avgCost;
  const pnl = value - basis;
  const pct = basis > 0 ? (pnl / basis) * 100 : 0;

  return (
    <div className="rounded-xl border border-accent/25 bg-ink-850/70 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-ink-100">Your position</h2>
        <span className="tnum text-sm font-bold text-ink-50">
          {shares.toLocaleString()} {shares === 1 ? "share" : "shares"}
        </span>
      </div>

      <dl className="mt-3 space-y-1.5 text-xs">
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">Average cost</dt>
          <dd className="tnum text-ink-200">{money(avgCost)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">{shares < 0 ? "Cost to cover" : "If you sold now"}</dt>
          <dd className={`tnum rounded px-1 text-ink-100 ${flash}`}>{money(Math.abs(value))}</dd>
        </div>
        <div className="my-2 border-t border-ink-750" />
        <div className="flex items-center justify-between">
          <dt className="text-ink-400">Unrealized P&L</dt>
          <dd className={`tnum text-sm font-bold ${trendClass(pnl)}`}>
            {signedMoney(pnl)} <span className="text-xs font-medium">({signedPct(pct)})</span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

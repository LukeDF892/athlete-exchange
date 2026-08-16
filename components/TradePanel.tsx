"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Player } from "@/lib/market/types";
import { quoteBuy, quoteSell, positionLimit, TRADE_FEE_RATE } from "@/lib/pricing/engine";
import { money, signedMoney, signedPct, trendClass } from "@/lib/format";
import { executeTrade } from "@/app/actions/trade";

/**
 * Order ticket.
 *
 * The quote shown here is computed client-side purely so the numbers update as
 * you type. It is never trusted: execute_trade() recomputes the cost from
 * server-held state, so a tampered client can only ever mislead itself.
 */
export function TradePanel({
  player,
  tradingEnabled = false,
  cash = null,
  sharesHeld = 0,
  avgCost = 0,
  blockedReason = "no-database",
}: {
  player: Player;
  tradingEnabled?: boolean;
  cash?: number | null;
  sharesHeld?: number;
  avgCost?: number;
  blockedReason?: "no-database" | "signed-out";
}) {
  const router = useRouter();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [raw, setRaw] = useState("10");
  const [isPending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const pending = isPending || submitting;

  const shares = Math.max(0, Math.floor(Number(raw) || 0));

  const quote = useMemo(() => {
    if (shares <= 0) return null;
    try {
      return side === "buy"
        ? quoteBuy(player.fairValue, player.sharesOutstanding, shares, player.liquidityDepth)
        : quoteSell(player.fairValue, player.sharesOutstanding, shares, player.liquidityDepth);
    } catch {
      return null;
    }
  }, [side, shares, player]);

  const slippagePct = quote ? ((quote.avgPrice - quote.priceBefore) / quote.priceBefore) * 100 : null;
  const canSell = side === "sell" && shares > sharesHeld;
  const tooExpensive = side === "buy" && cash != null && quote != null && quote.net > cash;

  // Mirrors the cap enforced in execute_trade(). Warning here rather than
  // letting the database reject the order keeps the limit legible instead of
  // arriving as a surprise after you commit.
  // A settled listing has already been bought back; there is nothing to trade.
  const settled = player.status === "settled";
  const limit = positionLimit(player.liquidityDepth);
  const overLimit = side === "buy" && sharesHeld + shares > limit;

  /**
   * Whether this trade makes or loses money, stated before you commit.
   *
   * A sale has a real answer: proceeds minus what those shares cost you. A
   * purchase does not — nobody knows the future — so instead it shows the
   * honest immediate one: what you would get back selling straight away, which
   * is the slippage you are paying to enter. Showing a made-up projection for a
   * buy would be worse than showing nothing.
   */
  const outcome = useMemo(() => {
    if (!quote || shares <= 0) return null;

    if (side === "sell") {
      if (sharesHeld <= 0 || avgCost <= 0) return null;
      const basis = shares * avgCost;
      const profit = quote.net - basis;
      return {
        label: profit >= 0 ? "Profit on this sale" : "Loss on this sale",
        profit,
        pct: basis > 0 ? (profit / basis) * 100 : null,
        detail: `${shares} @ ${money(avgCost)} cost ${money(basis)}`,
      };
    }

    // Buying: round-trip cost right now, which is slippage (plus any fee).
    try {
      const back = quoteSell(
        player.fairValue,
        player.sharesOutstanding + shares,
        shares,
        player.liquidityDepth
      );
      const profit = back.net - quote.net;
      return {
        label: "If you sold again immediately",
        profit,
        pct: quote.net > 0 ? (profit / quote.net) * 100 : null,
        detail: "the cost of entering at this size",
      };
    } catch {
      return null;
    }
  }, [side, shares, quote, sharesHeld, avgCost, player]);

  async function submit() {
    if (!quote || shares <= 0) return;
    setSubmitting(true);
    setError(null);
    setReceipt(null);
    try {
      const result = await executeTrade(player.id, side, shares);
      setReceipt(
        `${result.side === "buy" ? "Bought" : "Sold"} ${result.shares} @ ${money(
          result.avgPrice
        )} — ${result.side === "buy" ? "paid" : "received"} ${money(result.net)}`
      );
      // Pull the new price, cash balance and position down from the server.
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trade failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-ink-750 bg-ink-850/70 p-4">
      <div className="mb-3 flex rounded-lg border border-ink-700 bg-ink-900 p-0.5">
        {(["buy", "sell"] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            aria-pressed={side === s}
            className={`flex-1 rounded-md py-2 text-sm font-bold uppercase tracking-wide transition-colors ${
              side === s
                ? s === "buy"
                  ? "bg-up text-ink-950"
                  : "bg-down text-ink-950"
                : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <label className="block text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        Shares
      </label>
      <input
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        className="tnum mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-lg font-semibold text-ink-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />

      <div className="mt-2 flex gap-1.5">
        {[10, 25, 100].map((n) => (
          <button
            key={n}
            onClick={() => setRaw(String(n))}
            className="flex-1 rounded-md border border-ink-700 py-1 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800"
          >
            {n}
          </button>
        ))}
      </div>

      {quote && (
        <dl className="mt-4 space-y-1.5 text-xs">
          <Row label="Spot price" value={money(quote.priceBefore)} />
          <Row label="Average fill" value={money(quote.avgPrice)} />
          <Row label="Slippage" value={signedPct(slippagePct)} tone="warn" />
          {/* Only shown when a fee is actually charged — a permanent "$0.00"
              row is noise that implies a cost that does not exist. */}
          {quote.fee > 0 && (
            <Row label={`Fee (${(TRADE_FEE_RATE * 100).toFixed(2)}%)`} value={money(quote.fee)} />
          )}
          <div className="my-2 border-t border-ink-750" />
          <Row
            label={side === "buy" ? "Total cost" : "You receive"}
            value={money(quote.net)}
            strong
          />
          <Row label="Price after" value={money(quote.priceAfter)} />
        </dl>
      )}

      {/* The number that answers "am I making or losing money on this?" */}
      {outcome && (
        <div
          className={`mt-3 rounded-lg border px-3 py-2.5 ${
            outcome.profit > 0
              ? "border-up/30 bg-up-dim"
              : outcome.profit < 0
                ? "border-down/30 bg-down-dim"
                : "border-ink-700 bg-ink-900"
          }`}
        >
          <div className="flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-300">
              {outcome.label}
            </span>
            <span className={`tnum text-sm font-bold ${trendClass(outcome.profit)}`}>
              {signedMoney(outcome.profit)}
            </span>
          </div>
          <div className="mt-0.5 flex items-baseline justify-between">
            <span className="text-[11px] text-ink-400">{outcome.detail}</span>
            {outcome.pct != null && (
              <span className={`tnum text-[11px] ${trendClass(outcome.profit)}`}>
                {signedPct(outcome.pct)}
              </span>
            )}
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-lg bg-down-dim px-3 py-2 text-xs text-down">{error}</p>
      )}
      {receipt && (
        <p className="mt-3 rounded-lg bg-up-dim px-3 py-2 text-xs text-up">{receipt}</p>
      )}
      {tradingEnabled && cash != null && (
        <p className="mt-3 text-center text-[11px] text-ink-400">
          Buying power <span className="tnum text-ink-200">{money(cash)}</span>
          {sharesHeld > 0 && (
            <>
              {" · "}holding <span className="tnum text-ink-200">{sharesHeld}</span> shares
            </>
          )}
        </p>
      )}

      {canSell && (
        <p className="mt-3 rounded-lg bg-down-dim px-3 py-2 text-xs text-down">
          You hold {sharesHeld} shares.
        </p>
      )}
      {overLimit && (
        <p className="mt-3 rounded-lg bg-down-dim px-3 py-2 text-xs text-down">
          Position limit: you may hold at most {limit.toLocaleString()} shares of any one
          athlete{sharesHeld > 0 ? `, and already hold ${sharesHeld.toLocaleString()}` : ""}. The cap
          scales with liquidity so no single trader can set the price.
        </p>
      )}
      {tooExpensive && (
        <p className="mt-3 rounded-lg bg-down-dim px-3 py-2 text-xs text-down">
          Not enough cash — you have {money(cash!)}.
        </p>
      )}

      {tradingEnabled ? (
        <button
          onClick={submit}
          disabled={pending || shares <= 0 || canSell || tooExpensive || overLimit || settled}
          className={`mt-4 w-full rounded-lg py-2.5 text-sm font-bold uppercase tracking-wide transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            side === "buy" ? "bg-up text-ink-950" : "bg-down text-ink-950"
          } hover:brightness-110`}
        >
          {pending ? "Working…" : `${side} ${shares || 0} share${shares === 1 ? "" : "s"}`}
        </button>
      ) : (
        <div className="mt-4 rounded-lg border border-dashed border-ink-700 px-3 py-3 text-center">
          {blockedReason === "signed-out" ? (
            <>
              <a
                href="/login"
                className="block w-full rounded-lg bg-accent py-2.5 text-sm font-bold text-ink-950 transition-all hover:brightness-110"
              >
                Sign in to trade
              </a>
              <p className="mt-2 text-xs text-ink-400">
                New accounts start with $100,000 in play money.
              </p>
            </>
          ) : (
            <p className="text-xs leading-relaxed text-ink-400">
              Connect a Supabase project to enable accounts and live trading across devices. The
              quote above is real — it is the exact cost this order would clear at.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "warn";
}) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-400">{label}</dt>
      <dd
        className={`tnum ${strong ? "text-sm font-bold text-ink-50" : tone === "warn" ? "text-ink-300" : "text-ink-200"}`}
      >
        {value}
      </dd>
    </div>
  );
}

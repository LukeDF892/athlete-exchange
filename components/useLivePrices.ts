"use client";

import { useEffect, useState } from "react";
import type { RealtimePostgresUpdatePayload } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

/** Shape of the `players` columns realtime sends us. */
interface PlayerPriceRow {
  id: string;
  market_price: number;
  fair_value: number;
  shares_outstanding: number;
}

export interface LivePrice {
  marketPrice: number;
  fairValue: number;
  sharesOutstanding: number;
  /** Direction of the last change, for the flash animation. */
  direction: "up" | "down" | null;
}

/**
 * Subscribes to price changes on the `players` table.
 *
 * This is what makes the exchange feel alive across devices: when someone on
 * another phone buys McDavid, every open board sees the price move within a
 * second. Supabase Realtime pushes the changed row over a websocket, so there
 * is no polling.
 *
 * Returns a map keyed by player id containing only the players that have
 * actually changed since mount; callers fall back to their server-rendered
 * price for everything else.
 */
export function useLivePrices(enabled: boolean): Record<string, LivePrice> {
  const [prices, setPrices] = useState<Record<string, LivePrice>>({});

  useEffect(() => {
    if (!enabled) return;

    const supabase = getSupabaseBrowserClient();
    const channel = supabase
      .channel("market-prices")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "players" },
        (payload: RealtimePostgresUpdatePayload<PlayerPriceRow>) => {
          const row = payload.new;
          setPrices((prev) => {
            const previous = prev[row.id]?.marketPrice;
            return {
              ...prev,
              [row.id]: {
                marketPrice: row.market_price,
                fairValue: row.fair_value,
                sharesOutstanding: row.shares_outstanding,
                direction:
                  previous == null || previous === row.market_price
                    ? null
                    : row.market_price > previous
                      ? "up"
                      : "down",
              },
            };
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [enabled]);

  return prices;
}

"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { toTapeEntry, type TapeEntry, type TapeRow } from "@/lib/market/tape-row";

/**
 * The tape, kept current without a reload.
 *
 * The obvious implementation — subscribe to INSERTs on `trades` — does not
 * work, and fails in the most misleading way possible: RLS applies to realtime
 * as well as to queries, and "trades are self-readable" means the only inserts
 * a browser is ever told about are its own. The tape would come alive for
 * exactly the trades you already knew you had made, and stay dead for the bots
 * and the other traders, which is the entire point of having one.
 *
 * So the trigger and the data are two different things. `players` is public
 * (migration 0013) and every trade updates the row it traded, so a price change
 * is a reliable "something happened" signal; the tape itself is then re-read
 * from `trade_tape`, the view built to be publicly readable and to publish
 * share counts without the cash each trade moved.
 *
 * Refetches are debounced because the signal is noisier than the event: a
 * nightly ingest updates every listing on the board, and that is not thousands
 * of tape refreshes, it is one.
 */
const REFETCH_DEBOUNCE_MS = 800;

export function useLiveTape(
  initial: TapeEntry[],
  { playerId, limit = 12 }: { playerId?: string; limit?: number } = {}
): { entries: TapeEntry[]; isNew: (id: string) => boolean } {
  const [entries, setEntries] = useState<TapeEntry[]>(initial);
  /** Ids present before the socket connected — everything else arrived live. */
  const seen = useRef<Set<string>>(new Set(initial.map((e) => e.id)));

  // A fresh server render (a navigation, or router.refresh() after your own
  // trade) is newer than anything the socket has told us, so it wins.
  useEffect(() => {
    setEntries(initial);
    for (const e of initial) seen.current.add(e.id);
  }, [initial]);

  useEffect(() => {
    // Without a database the tape is whatever the server rendered, which is
    // nothing — and asking for the browser client here would throw on the
    // missing key rather than degrading quietly.
    if (!isSupabaseConfigured()) return;

    const supabase = getSupabaseBrowserClient();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const refetch = async () => {
      let query = supabase
        .from("trade_tape")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (playerId) query = query.eq("player_id", playerId);
      const { data, error } = await query;
      if (cancelled || error || !data) return;
      setEntries((data as TapeRow[]).map(toTapeEntry));
    };

    const channel = supabase
      .channel(playerId ? `tape-signal:${playerId}` : "tape-signal")
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "players",
          ...(playerId ? { filter: `id=eq.${playerId}` } : {}),
        },
        () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(refetch, REFETCH_DEBOUNCE_MS);
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [playerId, limit]);

  const isNew = (id: string) => !seen.current.has(id);
  return { entries, isNew };
}

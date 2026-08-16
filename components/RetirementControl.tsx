"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  searchListings,
  announceRetirement,
  settleRetirement,
  type AthleteMatch,
} from "@/app/actions/admin";
import { money } from "@/lib/format";

/**
 * Retire an athlete.
 *
 * Two things make this different from every other control in the app, and both
 * shape the design:
 *
 *   1. It is irreversible. Announcing starts a countdown every trader can see;
 *      settling pays out every holder in cash and closes the listing for good.
 *      There is no undo, so nothing here fires on a single click — the operator
 *      must confirm against the athlete's actual name.
 *   2. It affects other people's money. So the confirmation states plainly what
 *      will happen to holders, not just what will happen to the record.
 */
const DAY_OPTIONS = [7, 14, 30, 60];

export function RetirementControl() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AthleteMatch[]>([]);
  const [selected, setSelected] = useState<AthleteMatch | null>(null);
  const [days, setDays] = useState(30);
  const [confirming, setConfirming] = useState<"announce" | "settle" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function runSearch(q: string) {
    setQuery(q);
    setSelected(null);
    setConfirming(null);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults(await searchListings(q));
    } catch {
      setResults([]);
    }
  }

  async function commit(kind: "announce" | "settle") {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res =
        kind === "announce"
          ? await announceRetirement(selected.id, days)
          : await settleRetirement(selected.id);
      setResult(res.message);
      setConfirming(null);
      setSelected(null);
      setQuery("");
      setResults([]);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-warn/30 bg-ink-850/70 p-4">
      <h2 className="text-sm font-semibold text-ink-100">Retire an athlete</h2>
      <p className="mt-0.5 text-xs text-ink-400">
        The only control on this page that writes. Announcing starts a public countdown; settling
        buys out every holder in cash and closes the listing permanently.
      </p>

      <input
        value={query}
        onChange={(e) => void runSearch(e.target.value)}
        placeholder="Search by name…"
        aria-label="Search listings"
        className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-ink-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
      />

      {results.length > 0 && !selected && (
        <ul className="mt-2 divide-y divide-ink-800 overflow-hidden rounded-lg border border-ink-750">
          {results.map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  setSelected(r);
                  setResults([]);
                }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-ink-800"
              >
                <span className="min-w-0 truncate text-ink-100">
                  {r.fullName}{" "}
                  <span className="text-xs text-ink-500">
                    {r.sport.toUpperCase()} · {r.teamAbbrev ?? "—"}
                  </span>
                </span>
                <span className="flex items-center gap-2 whitespace-nowrap">
                  {r.status !== "active" && (
                    <span className="rounded bg-warn-dim px-1.5 py-0.5 text-[10px] font-semibold uppercase text-warn">
                      {r.status}
                    </span>
                  )}
                  <span className="tnum text-xs text-ink-300">{money(r.marketPrice)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div className="mt-3 rounded-lg border border-ink-750 bg-ink-900 p-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-semibold text-ink-50">{selected.fullName}</span>
            <span className="tnum text-xs text-ink-400">{money(selected.marketPrice)}</span>
          </div>
          <div className="mt-0.5 text-xs text-ink-500">
            {selected.sport.toUpperCase()} · {selected.teamAbbrev ?? "—"} · currently{" "}
            {selected.status}
            {selected.settlesAt && (
              <> · settles {new Date(selected.settlesAt).toLocaleDateString()}</>
            )}
          </div>

          {selected.status === "active" && (
            <div className="mt-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
                Countdown
              </span>
              <div className="mt-1 flex gap-1.5">
                {DAY_OPTIONS.map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d)}
                    aria-pressed={days === d}
                    className={`flex-1 rounded-md border py-1 text-xs font-medium transition-colors ${
                      days === d
                        ? "border-accent bg-accent/15 text-ink-50"
                        : "border-ink-700 text-ink-300 hover:bg-ink-800"
                    }`}
                  >
                    {d}d
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Nothing fires on one click. */}
          {confirming ? (
            <div className="mt-3 rounded-lg border border-down/40 bg-down-dim p-3">
              <p className="text-xs leading-relaxed text-ink-100">
                {confirming === "announce" ? (
                  <>
                    Announce that <strong>{selected.fullName}</strong> retires in{" "}
                    <strong>{days} days</strong>? Every trader will see the countdown, and trading
                    stays open until it expires.
                  </>
                ) : (
                  <>
                    Settle <strong>{selected.fullName}</strong> now? Every holder is bought out in
                    cash at the settlement price and the listing closes permanently.{" "}
                    <strong>This cannot be undone.</strong>
                  </>
                )}
              </p>
              <div className="mt-2.5 flex gap-2">
                <button
                  onClick={() => void commit(confirming)}
                  disabled={busy}
                  className="flex-1 rounded-lg bg-down py-2 text-xs font-bold uppercase tracking-wide text-ink-950 transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? "Working…" : `Yes, ${confirming}`}
                </button>
                <button
                  onClick={() => setConfirming(null)}
                  disabled={busy}
                  className="flex-1 rounded-lg border border-ink-700 py-2 text-xs font-medium text-ink-200 transition-colors hover:bg-ink-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              {selected.status === "active" && (
                <button
                  onClick={() => setConfirming("announce")}
                  className="flex-1 rounded-lg border border-warn/40 py-2 text-xs font-semibold text-warn transition-colors hover:bg-warn-dim"
                >
                  Announce retirement
                </button>
              )}
              {selected.status === "retiring" && (
                <button
                  onClick={() => setConfirming("settle")}
                  className="flex-1 rounded-lg border border-down/40 py-2 text-xs font-semibold text-down transition-colors hover:bg-down-dim"
                >
                  Settle now
                </button>
              )}
              <button
                onClick={() => {
                  setSelected(null);
                  setQuery("");
                }}
                className="rounded-lg border border-ink-700 px-3 py-2 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800"
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

      {error && <p className="mt-3 rounded-lg bg-down-dim px-3 py-2 text-xs text-down">{error}</p>}
      {result && <p className="mt-3 rounded-lg bg-up-dim px-3 py-2 text-xs text-up">{result}</p>}
    </div>
  );
}

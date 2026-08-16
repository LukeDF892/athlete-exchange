"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleWatch } from "@/app/actions/watchlist";

/**
 * Follow an athlete without owning them.
 *
 * Optimistic on purpose: following is cheap and reversible, so the star should
 * respond instantly rather than waiting on a round trip. If the write fails the
 * state rolls back and the error surfaces, which is the right trade for
 * something this low-stakes.
 */
export function WatchButton({
  playerId,
  initialWatching,
  disabled = false,
  compact = false,
}: {
  playerId: string;
  initialWatching: boolean;
  /** Signed out — the control still shows, but explains itself instead. */
  disabled?: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const [watching, setWatching] = useState(initialWatching);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function onClick() {
    if (disabled || busy) return;
    const next = !watching;
    setWatching(next);
    setBusy(true);
    try {
      await toggleWatch(playerId);
      startTransition(() => router.refresh());
    } catch {
      setWatching(!next);
    } finally {
      setBusy(false);
    }
  }

  const label = watching ? "Following" : "Follow";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={watching}
      title={disabled ? "Sign in to follow athletes" : label}
      className={`inline-flex items-center gap-1.5 rounded-lg border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        compact ? "px-2 py-1 text-[11px]" : "px-3 py-1.5 text-xs"
      } ${
        watching
          ? "border-accent bg-accent-dim text-accent"
          : "border-ink-700 text-ink-400 hover:text-ink-100"
      }`}
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          d="M10 2.5l2.32 4.7 5.18.75-3.75 3.66.89 5.16L10 14.34l-4.64 2.43.89-5.16L2.5 7.95l5.18-.75L10 2.5z"
          fill={watching ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </button>
  );
}

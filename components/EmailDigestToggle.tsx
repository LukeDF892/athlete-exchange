"use client";

import { useState } from "react";
import { setEmailDigest } from "@/app/actions/trade";

/**
 * Opt in to the daily email.
 *
 * Off unless you turn it on, and the label says what will actually arrive
 * rather than "notifications" — people agree to mail far more readily than they
 * agree to whatever "notifications" turns out to mean, and then resent it.
 */
export function EmailDigestToggle({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    // Optimistic: the switch should feel immediate, and it reverts on failure.
    setOn(next);
    try {
      await setEmailDigest(next);
    } catch (err) {
      setOn(!next);
      setError(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink-100">Daily email</p>
        <p className="mt-0.5 text-xs text-ink-400">
          One message a day, only when something you hold actually moved. Nothing on a quiet day.
        </p>
        {error && <p className="mt-1 text-xs text-down">{error}</p>}
      </div>
      <button
        onClick={() => void toggle()}
        disabled={busy}
        role="switch"
        aria-checked={on}
        aria-label="Daily email"
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
          on ? "bg-accent" : "bg-ink-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-ink-950 transition-transform ${
            on ? "translate-x-[22px]" : "translate-x-0.5"
          }`}
        />
      </button>
    </div>
  );
}

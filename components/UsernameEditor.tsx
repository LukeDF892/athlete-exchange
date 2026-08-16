"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { changeUsername } from "@/app/actions/trade";

/**
 * Change the name that appears on the leaderboard.
 *
 * Worth having because the earliest accounts were auto-named `trader_3f2a91c4`
 * from their user id — a name nobody chose and nobody recognises. It sits
 * inline rather than on a settings page, since the portfolio header is the one
 * place the name is already shown.
 */
export function UsernameEditor({ username }: { username: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(username);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, startTransition] = useTransition();

  async function save() {
    const next = value.trim();
    if (next === username) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await changeUsername(next);
      setValue(result.username);
      setEditing(false);
      startTransition(() => router.refresh());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change your username");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <p className="mt-1.5 text-sm text-ink-400">
        Signed in as <span className="text-ink-200">{username}</span>{" "}
        <button
          onClick={() => {
            setValue(username);
            setError(null);
            setEditing(true);
          }}
          className="text-xs text-accent underline-offset-2 hover:underline"
        >
          change
        </button>
      </p>
    );
  }

  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <input
          autoFocus
          value={value}
          maxLength={20}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
          aria-label="Username"
          className="w-44 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-sm text-ink-50 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={() => void save()}
          disabled={saving || value.trim().length < 3}
          className="rounded-lg bg-accent px-3 py-1.5 text-xs font-bold text-ink-950 transition-all hover:brightness-110 disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => setEditing(false)}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-ink-800"
        >
          Cancel
        </button>
      </div>
      <p className={`mt-1 text-xs ${error ? "text-down" : "text-ink-500"}`}>
        {error ?? "3–20 characters. Letters, numbers and underscores. Shown on the leaderboard."}
      </p>
    </div>
  );
}

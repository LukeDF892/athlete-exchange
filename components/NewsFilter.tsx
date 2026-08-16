"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { NewsItem } from "@/lib/market/types";
import { timeAgo } from "@/lib/format";
import { SportBadge } from "@/components/ui";

type Item = NewsItem & {
  playerNames: Array<{ id: string; name: string }>;
  /** Names and teams of tagged athletes, lowercased once for searching. */
  searchText?: string;
};

export function NewsFilter({
  items,
  heldPlayerIds = [],
  watchedPlayerIds = [],
}: {
  items: Item[];
  /** Athletes the signed-in user holds, for the portfolio filter. */
  heldPlayerIds?: string[];
  /** Athletes the user follows but may not own — the reason to keep reading. */
  watchedPlayerIds?: string[];
}) {
  const [sport, setSport] = useState<"all" | "nba" | "nhl" | "mlb">("all");
  const [query, setQuery] = useState("");
  const [taggedOnly, setTaggedOnly] = useState(false);
  const [mineOnly, setMineOnly] = useState(false);
  const [followedOnly, setFollowedOnly] = useState(false);
  const held = useMemo(() => new Set(heldPlayerIds), [heldPlayerIds]);
  const watched = useMemo(() => new Set(watchedPlayerIds), [watchedPlayerIds]);

  const rows = useMemo(() => {
    let list = items;
    if (sport !== "all") list = list.filter((n) => n.sport === sport);
    if (taggedOnly) list = list.filter((n) => n.playerNames.length > 0);
    if (mineOnly) list = list.filter((n) => n.playerIds.some((id) => held.has(id)));
    if (followedOnly) list = list.filter((n) => n.playerIds.some((id) => watched.has(id)));

    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (n.summary ?? "").toLowerCase().includes(q) ||
          // Tagged athletes carry their name and team, so searching "Oilers"
          // or "McDavid" finds stories whose headline never spells it out.
          (n.searchText ?? "").includes(q)
      );
    }
    return list;
  }, [items, sport, taggedOnly, mineOnly, followedOnly, held, watched, query]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-ink-700 bg-ink-850 p-0.5">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search headlines, players, teams"
            aria-label="Search news"
            className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent sm:w-64"
          />
          {(["all", "nba", "nhl", "mlb"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSport(s)}
              aria-pressed={sport === s}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold uppercase tracking-wide transition-colors ${
                sport === s ? "bg-ink-700 text-ink-50" : "text-ink-400 hover:text-ink-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <button
          onClick={() => setTaggedOnly((v) => !v)}
          aria-pressed={taggedOnly}
          className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
            taggedOnly
              ? "border-accent bg-accent-dim text-accent"
              : "border-ink-700 text-ink-400 hover:text-ink-200"
          }`}
        >
          Linked to an athlete
        </button>
        {heldPlayerIds.length > 0 && (
          <button
            onClick={() => setMineOnly((v) => !v)}
            aria-pressed={mineOnly}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              mineOnly
                ? "border-up bg-up-dim text-up"
                : "border-ink-700 text-ink-400 hover:text-ink-200"
            }`}
          >
            My athletes
          </button>
        )}
        {watchedPlayerIds.length > 0 && (
          <button
            onClick={() => setFollowedOnly((v) => !v)}
            aria-pressed={followedOnly}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              followedOnly
                ? "border-accent bg-accent-dim text-accent"
                : "border-ink-700 text-ink-400 hover:text-ink-200"
            }`}
          >
            Following
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="py-14 text-center text-sm text-ink-400">No stories match this filter.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((item) => (
            <li
              key={item.id}
              className="rounded-xl border border-ink-750 bg-ink-850/50 p-4 transition-colors hover:border-ink-600"
            >
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="block">
                <div className="flex items-start justify-between gap-3">
                  <h2 className="text-sm font-semibold leading-snug text-ink-50">{item.title}</h2>
                  {item.sport && <SportBadge sport={item.sport} />}
                </div>
                {item.summary && (
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-400">
                    {item.summary}
                  </p>
                )}
                <div className="mt-2 text-[11px] text-ink-500">
                  {item.source} · {timeAgo(item.publishedAt)}
                </div>
              </a>

              {item.playerNames.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {item.playerNames.map((p) => (
                    <Link
                      key={p.id}
                      href={`/player/${p.id}`}
                      className="rounded-full border border-ink-700 bg-ink-800 px-2.5 py-0.5 text-[11px] font-medium text-ink-200 transition-colors hover:border-accent hover:text-accent"
                    >
                      {p.name}
                    </Link>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

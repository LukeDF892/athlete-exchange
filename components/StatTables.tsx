"use client";

import { useState } from "react";
import type { GameLogEntry, StatTable } from "@/lib/providers/types";

/**
 * Career / season / recent stats with a game log, switched by tab.
 * Windows the feed did not supply are simply absent rather than shown empty.
 */
export function StatTables({
  tables,
  gameLog,
}: {
  tables: StatTable[];
  gameLog: GameLogEntry[];
}) {
  const tabs = [
    ...tables.map((t) => ({ key: t.window, label: t.label })),
    ...(gameLog.length > 0 ? [{ key: "log" as const, label: "Game log" }] : []),
  ];
  const [active, setActive] = useState<string>(tabs[0]?.key ?? "season");

  if (tabs.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-400">No statistics available.</p>;
  }

  const table = tables.find((t) => t.window === active);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1 border-b border-ink-800 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            aria-pressed={active === tab.key}
            className={`rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              active === tab.key
                ? "bg-ink-700 text-ink-50"
                : "text-ink-400 hover:text-ink-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "log" ? (
        <ul className="divide-y divide-ink-800">
          {gameLog.map((g, i) => (
            <li key={`${g.date}-${i}`} className="flex items-center justify-between py-2.5">
              <div>
                <div className="text-sm text-ink-100">
                  {g.homeAway === "away" ? "@" : "vs"} {g.opponent ?? "—"}
                </div>
                <div className="text-xs text-ink-400">
                  {g.date ? new Date(g.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : ""}
                </div>
              </div>
              <div className="tnum text-right text-xs text-ink-300">{g.summary}</div>
            </li>
          ))}
        </ul>
      ) : table ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          {table.rows.map((row) => (
            <div key={row.label} className="rounded-lg bg-ink-850 px-2.5 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-ink-400">
                {row.label}
              </div>
              <div className="tnum mt-0.5 text-sm font-semibold text-ink-100">{row.value}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

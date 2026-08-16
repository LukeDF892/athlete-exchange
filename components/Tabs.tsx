"use client";

import { useState } from "react";

export interface TabDef {
  id: string;
  label: string;
  /** Shown as a small count beside the label. */
  count?: number;
  content: React.ReactNode;
}

/**
 * Client-side tab strip.
 *
 * All panels are rendered by the server and swapped here rather than fetched
 * per tab, because the data is already loaded and switching should be instant.
 * The portfolio had grown into one long scroll where the activity list buried
 * the positions; tabs put each thing where you would look for it.
 */
export function Tabs({ tabs, initial }: { tabs: TabDef[]; initial?: string }) {
  const [active, setActive] = useState(initial ?? tabs[0]?.id);
  const current = tabs.find((t) => t.id === active) ?? tabs[0];

  return (
    <div>
      <div
        role="tablist"
        aria-label="Portfolio sections"
        className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-ink-750 bg-ink-875 p-1"
      >
        {tabs.map((t) => {
          const selected = t.id === current?.id;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={selected}
              onClick={() => setActive(t.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                selected ? "bg-ink-750 text-ink-50" : "text-ink-400 hover:text-ink-100"
              }`}
            >
              {t.label}
              {t.count != null && t.count > 0 && (
                <span
                  className={`tnum rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                    selected ? "bg-ink-700 text-ink-200" : "bg-ink-800 text-ink-400"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">{current?.content}</div>
    </div>
  );
}

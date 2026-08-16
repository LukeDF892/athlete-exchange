import type { NewsItem } from "@/lib/market/types";
import { timeAgo } from "@/lib/format";
import { Card, SportBadge } from "@/components/ui";

/**
 * A plain list of stories, used wherever news appears outside the news page —
 * the portfolio feed and the per-athlete section both render through this so
 * they stay consistent as the styling evolves.
 */
export function NewsList({
  items,
  title,
  emptyBody,
  playerNames,
}: {
  items: NewsItem[];
  title: string;
  emptyBody: string;
  /** Optional id → name map, to show which of your athletes a story mentions. */
  playerNames?: Record<string, string>;
}) {
  if (items.length === 0) {
    return (
      <Card className="p-4">
        <h2 className="mb-1 text-sm font-semibold text-ink-100">{title}</h2>
        <p className="py-6 text-center text-sm text-ink-400">{emptyBody}</p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-ink-750 px-4 py-3">
        <h2 className="text-sm font-semibold text-ink-100">
          {title} <span className="text-ink-400">({items.length})</span>
        </h2>
      </div>
      <ul className="divide-y divide-ink-800">
        {items.map((item) => {
          const mentioned = playerNames
            ? item.playerIds.map((id) => playerNames[id]).filter(Boolean)
            : [];
          return (
            <li key={item.id}>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block px-4 py-3 transition-colors hover:bg-ink-850"
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 text-sm font-medium text-ink-100">
                    {item.title}
                  </span>
                  {item.sport && <SportBadge sport={item.sport} />}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-400">
                  <span>{item.source}</span>
                  <span aria-hidden="true">·</span>
                  <span>{timeAgo(item.publishedAt)}</span>
                  {mentioned.length > 0 && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span className="text-accent">{mentioned.join(", ")}</span>
                    </>
                  )}
                </div>
              </a>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

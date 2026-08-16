import { money } from "@/lib/format";
import type { Player } from "@/lib/market/types";

/**
 * The wind-down notice on a retiring or settled listing.
 *
 * Written to be read by someone holding shares and wondering what happens to
 * them, so it states the mechanism plainly rather than just flagging a status.
 * The reassuring part is the true part: settlement pays the better of the
 * average price over the window and fair value, so there is no advantage to
 * selling first and no way for a rush to the exit to leave you with nothing.
 */
export function RetirementBanner({ player }: { player: Player }) {
  if (player.status === "settled") {
    return (
      <div className="rounded-xl border border-ink-700 bg-ink-875 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink-100">Retired and settled</h2>
          <span className="tnum text-sm font-bold text-ink-100">
            {money(player.settlementPrice ?? player.marketPrice)}
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-400">
          Trading in {player.fullName} has closed. Every share was bought back at the settlement
          price and paid out as cash — nobody was left holding anything.
        </p>
      </div>
    );
  }

  if (player.status !== "retiring") return null;

  const settles = player.settlesAt ? new Date(player.settlesAt) : null;
  const daysLeft = settles
    ? Math.max(0, Math.ceil((settles.getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <div className="rounded-xl border border-warn/40 bg-warn-dim p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-warn">Retiring</h2>
        {daysLeft != null && (
          <span className="tnum text-sm font-bold text-warn">
            {daysLeft} {daysLeft === 1 ? "day" : "days"} left
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-300">
        {player.fullName} has announced their retirement. Trading continues until{" "}
        {settles
          ? settles.toLocaleDateString("en-US", { month: "long", day: "numeric" })
          : "settlement"}
        , then every remaining share is bought back for cash.
      </p>
      <p className="mt-2 text-xs leading-relaxed text-ink-400">
        Settlement pays the <span className="text-ink-200">better</span> of the average price across
        this window and the performance value at close — so selling early carries no advantage, and
        a rush for the exit cannot leave holders with nothing.
      </p>
    </div>
  );
}

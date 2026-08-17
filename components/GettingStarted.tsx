import Link from "next/link";

/**
 * What to do when you have just arrived.
 *
 * A first visit lands on more than five thousand listings with no indication of
 * where to start, what the two numbers on each row mean, or that an account is
 * free play money. People who do not already know what a bonding curve is were
 * being asked to infer one from a table.
 *
 * Shown only to signed-out visitors — once you have an account you have seen
 * this, and a permanent explainer above the market would be clutter.
 */
export function GettingStarted() {
  return (
    <section className="mb-7 rounded-xl border border-accent/25 bg-ink-875 p-4">
      <h2 className="text-sm font-semibold text-ink-50">New here?</h2>
      <p className="mt-1 text-sm leading-relaxed text-ink-300">
        Every athlete opens at a price built from their real production. You are betting on where
        the crowd takes it from there — not on tonight&rsquo;s game.
      </p>

      <ol className="mt-3 grid gap-2.5 sm:grid-cols-3">
        <Step
          n={1}
          title="Read a row"
          body="Performance is what their stats are worth. Price is what people are paying. The gap between them is the market's opinion."
        />
        <Step
          n={2}
          title="Find someone you rate"
          body="Search by name or team, or filter to a league. If you think the price is behind the player, that is your trade."
        />
        <Step
          n={3}
          title="Buy in"
          body="Accounts are free and start with $100,000 of play money. No real money is involved anywhere."
        />
      </ol>

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Link
          href="/login"
          className="rounded-lg bg-accent px-3.5 py-2 text-sm font-bold text-ink-950 transition-all hover:brightness-110"
        >
          Create an account
        </Link>
        <Link
          href="/digest"
          className="rounded-lg border border-ink-700 px-3.5 py-2 text-sm font-medium text-ink-200 transition-colors hover:bg-ink-800"
        >
          See what moved today
        </Link>
        <span className="text-xs text-ink-500">
          Prices update daily from live stats. Some traders here are bots, and they are labelled.
        </span>
      </div>
    </section>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="rounded-lg border border-ink-750 bg-ink-850/60 p-3">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent text-[11px] font-bold text-ink-950">
          {n}
        </span>
        <span className="text-xs font-semibold text-ink-100">{title}</span>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-ink-400">{body}</p>
    </div>
  );
}

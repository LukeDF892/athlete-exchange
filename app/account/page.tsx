import { redirect } from "next/navigation";
import { getPortfolio } from "@/lib/market/portfolio";
import { signOut } from "@/app/actions/trade";
import { UsernameEditor } from "@/components/UsernameEditor";
import { EmailDigestToggle } from "@/components/EmailDigestToggle";
import { Card } from "@/components/ui";
import { money } from "@/lib/format";

/**
 * Your account, in one place.
 *
 * Username editing and the digest toggle both existed, buried at the top of the
 * portfolio page next to a table of positions — so "change my name" meant
 * knowing to look at a screen about money. They are the same two controls; this
 * is a page that admits they are settings.
 *
 * What is deliberately not here: any way to change a balance, a position or a
 * price. The only column a user may write on their own profile is `username`,
 * enforced by RLS in migration 0012 rather than by this page — see the note in
 * CLAUDE.md about the policy that pinned `is_admin` but not `cash_balance`.
 */
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const portfolio = await getPortfolio();
  if (!portfolio) redirect("/login");

  return (
    <div className="rise mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight text-ink-50">Account</h1>
        <p className="mt-1.5 text-sm text-ink-400">
          Your name on the leaderboard and the tape, and whether the daily digest reaches you.
        </p>
      </header>

      <div className="space-y-4">
        <Card className="p-4">
          <h2 className="text-sm font-semibold text-ink-100">Display name</h2>
          <p className="mt-1 text-xs text-ink-400">
            Shown to other traders on the leaderboard and beside every trade you make. Three to
            twenty characters, letters, numbers and underscores.
          </p>
          <div className="mt-3">
            <UsernameEditor username={portfolio.username} />
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-ink-100">Daily digest</h2>
          <p className="mt-1 text-xs text-ink-400">
            One email a day covering what moved and why. A quiet day sends nothing at all rather
            than mailing to say nothing happened.
          </p>
          <div className="mt-3">
            <EmailDigestToggle initial={portfolio.emailDigest} />
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="text-sm font-semibold text-ink-100">This account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-ink-400">Net worth</dt>
              <dd className="tnum text-ink-100">{money(portfolio.netWorth)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-400">Buying power</dt>
              <dd className="tnum text-ink-100">{money(portfolio.cash)}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-ink-400">Open positions</dt>
              <dd className="tnum text-ink-100">{portfolio.positions.length}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-ink-500">
            Balances and positions can only be changed by trading. Nobody — including whoever runs
            the exchange — can edit them from a page.
          </p>
        </Card>

        <form action={signOut}>
          <button
            type="submit"
            className="w-full rounded-lg border border-ink-700 py-2.5 text-sm font-medium text-ink-300 transition-colors hover:bg-ink-800"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );
}

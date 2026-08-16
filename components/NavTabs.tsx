"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Market" },
  { href: "/digest", label: "Today" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/leaderboard", label: "Ranks" },
  { href: "/news", label: "News" },
];

/**
 * `signedIn` decides whether the account call-to-action appears.
 *
 * Without it there was no route to signing up anywhere in the chrome — a new
 * visitor had to guess that Portfolio leads to a sign-in page. On a public
 * site, where most arrivals have never seen the app, that is the difference
 * between a link that converts and one that looks read-only.
 */
export function NavTabs({ signedIn = false }: { signedIn?: boolean }) {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1" aria-label="Main">
      {TABS.map((tab) => {
        const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-lg px-2 py-1.5 text-sm font-medium transition-colors sm:px-3 ${
              active ? "bg-ink-800 text-ink-50" : "text-ink-400 hover:text-ink-100"
            }`}
          >
            {tab.label}
          </Link>
        );
      })}

      {!signedIn && !pathname.startsWith("/login") && (
        <Link
          href="/login"
          className="ml-0.5 whitespace-nowrap rounded-lg bg-accent px-2.5 py-1.5 text-sm font-bold text-ink-950 transition-all hover:brightness-110 sm:px-3"
        >
          Sign in
        </Link>
      )}
    </nav>
  );
}

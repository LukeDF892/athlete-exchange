import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";
import { NavTabs } from "@/components/NavTabs";
import { isSignedIn } from "@/lib/market/portfolio";

export const metadata: Metadata = {
  title: "Athlete Exchange — the stock market for athletes",
  description:
    "Buy and sell shares in NBA and NHL athletes. Prices start from real career performance and move with the market.",
};

export const viewport: Viewport = {
  themeColor: "#06070a",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const signedIn = await isSignedIn();
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <header className="sticky top-0 z-40 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-3 sm:px-4">
            <Link href="/" className="flex items-center gap-2.5">
              <span
                className="flex h-7 w-7 items-center justify-center rounded-md text-[13px] font-black text-ink-950"
                style={{
                  background: "linear-gradient(135deg, var(--color-up), var(--color-accent))",
                }}
                aria-hidden="true"
              >
                AX
              </span>
              <span className="hidden text-sm font-bold tracking-tight text-ink-50 sm:inline">
                Athlete Exchange
              </span>
            </Link>
            <NavTabs signedIn={signedIn} />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6">{children}</main>

        <footer className="border-t border-ink-800 py-6">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 text-xs text-ink-500 sm:flex-row sm:items-center sm:justify-between">
            <span>
              Play money only — no real currency, no wagering. Stats from the NHL public API,
              ESPN and MLB.
            </span>
            <span className="flex items-center gap-3">
              <Link href="/terms" className="transition-colors hover:text-ink-300">
                Terms &amp; Privacy
              </Link>
              <span>&copy; {new Date().getFullYear()} Athlete Exchange</span>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}

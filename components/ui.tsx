import Link from "next/link";
import type { ReactNode } from "react";
import type { Sport } from "@/lib/pricing/engine";

const SPORT_STYLE: Record<Sport, { color: string; background: string }> = {
  nba: { color: "var(--color-nba)", background: "rgba(240,128,60,0.12)" },
  nhl: { color: "var(--color-nhl)", background: "rgba(86,184,255,0.12)" },
  mlb: { color: "var(--color-mlb)", background: "rgba(120,200,140,0.12)" },
};

export function SportBadge({ sport }: { sport: Sport }) {
  const style = SPORT_STYLE[sport] ?? SPORT_STYLE.nba;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider"
      style={style}
    >
      {sport}
    </span>
  );
}

/**
 * Player headshot with a graceful fallback.
 *
 * Feed headshots 404 regularly (traded players, new call-ups), and a broken
 * image icon on a trading board looks amateurish, so initials sit underneath
 * and show through whenever the image fails to paint.
 */
export function PlayerAvatar({
  name,
  src,
  size = 40,
}: {
  name: string;
  src: string | null;
  size?: number;
}) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((n) => n[0])
    .join("")
    .toUpperCase();

  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink-700 bg-ink-750"
      style={{ width: size, height: size }}
    >
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold text-ink-300"
        style={{ fontSize: size * 0.36 }}
      >
        {initials}
      </span>
      {src && (
        // eslint-disable-next-line @next/next/no-img-element -- remote sports CDNs, many hosts
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="relative h-full w-full object-cover object-top"
sizes={`${size}px`}
        />
      )}
    </span>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-ink-750 bg-ink-875/60 backdrop-blur-sm ${className}`}
      style={{ background: "color-mix(in oklab, var(--color-ink-850) 75%, transparent)" }}
    >
      {children}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "neutral" | "up" | "down" | "accent";
}) {
  const color =
    tone === "up"
      ? "text-up"
      : tone === "down"
        ? "text-down"
        : tone === "accent"
          ? "text-accent"
          : "text-ink-100";
  return (
    <div className="rounded-lg border border-ink-750 bg-ink-850/60 px-3 py-2.5">
      <div className="text-[10px] font-medium uppercase tracking-wider text-ink-400">{label}</div>
      <div className={`tnum mt-1 text-lg font-semibold ${color}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-700 px-6 py-16 text-center">
      <h3 className="text-base font-semibold text-ink-100">{title}</h3>
      <p className="mt-1.5 max-w-md text-sm text-ink-400">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ButtonLink({
  href,
  children,
  variant = "primary",
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost";
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-4 py-2 text-sm font-semibold transition-colors";
  const styles =
    variant === "primary"
      ? "bg-accent text-ink-950 hover:brightness-110"
      : "border border-ink-700 text-ink-200 hover:bg-ink-800";
  return (
    <Link href={href} className={`${base} ${styles}`}>
      {children}
    </Link>
  );
}

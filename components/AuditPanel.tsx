import { Card } from "@/components/ui";
import type { AuditResult, Level } from "@/lib/market/audit";

/**
 * The tripwires, on screen.
 *
 * Every incident this exchange has had was found by eye, days late, because
 * nothing was watching. The audit runs four times a day and stores its result;
 * this is that result, so "is anything wrong" is a glance rather than a script
 * you have to remember to run.
 *
 * Deliberately shows the threshold next to the number. A metric without the
 * line it is being judged against is a number you have to hold in your head,
 * and the point of a tripwire is that you do not.
 */
const TONE: Record<Level, { dot: string; label: string; text: string }> = {
  green: { dot: "bg-up", label: "GREEN", text: "text-up" },
  yellow: { dot: "bg-warn", label: "YELLOW", text: "text-warn" },
  red: { dot: "bg-down", label: "RED", text: "text-down" },
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function AuditPanel({ result }: { result: AuditResult | null }) {
  if (!result) {
    return (
      <Card className="p-4">
        <h2 className="text-sm font-semibold text-ink-100">Market health</h2>
        <p className="mt-2 text-sm text-ink-400">
          No audit recorded yet. It runs at the end of each refresh cron, or on demand with{" "}
          <code className="rounded bg-ink-800 px-1 text-xs">npm run audit:market</code>.
        </p>
      </Card>
    );
  }

  const tone = TONE[result.level];

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-ink-750 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${tone.dot}`} aria-hidden="true" />
          <h2 className="text-sm font-semibold text-ink-100">Market health</h2>
          <span className={`text-xs font-bold ${tone.text}`}>{tone.label}</span>
        </div>
        <span className="text-xs text-ink-500">checked {ago(result.ranAt)}</span>
      </div>

      <ul className="divide-y divide-ink-800">
        {result.checks.map((c) => {
          const t = TONE[c.level];
          return (
            <li key={c.name} className="flex items-start gap-3 px-4 py-3">
              <span
                className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${t.dot}`}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-medium text-ink-100">
                    {c.name.replace(/_/g, " ")}
                  </span>
                  <span className={`tnum text-sm font-bold ${t.text}`}>{c.value}</span>
                </div>
                <p className="mt-0.5 text-xs text-ink-400">{c.detail}</p>
                <p className="mt-0.5 text-[11px] text-ink-500">{c.threshold}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

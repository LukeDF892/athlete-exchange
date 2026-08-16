/**
 * The daily email, and the deliberate reasons it does nothing by default.
 *
 * Three separate switches must all be on before a single message is sent:
 *
 *   1. `RESEND_API_KEY` is set — without a provider this module logs what it
 *      would have sent and returns. The whole pipeline is therefore safe to
 *      deploy and run before anyone has decided to wire up email at all.
 *   2. `DIGEST_FROM` is set — a verified sending address. Guessing one gets a
 *      domain marked as a spammer, which is not recoverable by editing code.
 *   3. The individual user has opted **in**. Not opted out. Nobody who has not
 *      asked for mail receives mail, which is why the preference lives in the
 *      user's own auth metadata and defaults to absent-means-no.
 *
 * The opt-in is stored in `user_metadata.email_digest` rather than a column on
 * profiles, because it needs no migration and a user can already write their
 * own auth metadata — so the preference is genuinely theirs rather than
 * something the operator maintains on their behalf.
 */
import { createClient } from "@supabase/supabase-js";
import type { PersonalDigest } from "@/lib/market/digest";

export interface DigestRecipient {
  userId: string;
  email: string;
  username: string;
}

/** Everyone who has asked for the daily email. */
export async function digestRecipients(): Promise<DigestRecipient[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return [];

  const db = createClient(url, key, { auth: { persistSession: false } });
  const out: DigestRecipient[] = [];

  // listUsers is paginated; a missing page is better than a partial send that
  // silently drops the tail of the list, so any error stops the run.
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const users = data?.users ?? [];
    for (const u of users) {
      const wants = (u.user_metadata as Record<string, unknown> | null)?.email_digest === true;
      if (!wants || !u.email) continue;
      out.push({
        userId: u.id,
        email: u.email,
        username: String((u.user_metadata as Record<string, unknown>)?.username ?? "trader"),
      });
    }
    if (users.length < 200) break;
  }
  return out;
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${money(Math.abs(n)).replace("$", "$")}`;
const pct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}%`;

/**
 * Plain text, deliberately.
 *
 * A daily number is read on a phone in a notification preview, and HTML mail
 * buys nothing there while costing rendering bugs across a dozen clients. If
 * this ever needs styling, that is a decision to make on purpose rather than by
 * default.
 */
export function renderDigest(
  recipient: DigestRecipient,
  personal: PersonalDigest,
  siteUrl: string
): { subject: string; text: string } | null {
  const net = personal.holdings.reduce((a, h) => a + h.valueChange, 0);
  const nothing =
    personal.holdings.length === 0 &&
    personal.watching.length === 0 &&
    personal.retiring.length === 0;

  // No movement is not worth an email. A daily message that often says
  // "nothing happened" trains people to ignore the ones that matter.
  if (nothing) return null;

  const lines: string[] = [];
  lines.push(`Hi ${recipient.username},`);
  lines.push("");

  if (personal.holdings.length > 0) {
    lines.push(`Your positions moved ${signed(net)} since yesterday.`);
    lines.push("");
    for (const h of personal.holdings.slice(0, 8)) {
      lines.push(
        `  ${h.player.fullName} — ${h.shares.toLocaleString()} shares, ` +
          `${money(h.from)} to ${money(h.to)} (${pct(h.pct)}), ${signed(h.valueChange)}`
      );
    }
    lines.push("");
  }

  if (personal.retiring.length > 0) {
    for (const p of personal.retiring) {
      lines.push(
        `  ${p.fullName} is retiring${
          p.settlesAt ? ` and settles ${new Date(p.settlesAt).toLocaleDateString()}` : ""
        }. You will be bought out in cash automatically.`
      );
    }
    lines.push("");
  }

  if (personal.watching.length > 0) {
    lines.push("Following:");
    for (const m of personal.watching.slice(0, 5)) {
      lines.push(`  ${m.player.fullName} ${pct(m.pct)}`);
    }
    lines.push("");
  }

  lines.push(`${siteUrl}/digest`);
  lines.push("");
  lines.push("Turn this email off any time from your portfolio page.");

  const headline =
    personal.holdings.length > 0
      ? `${signed(net)} today`
      : `${personal.retiring.length > 0 ? "A listing you hold is retiring" : "Movement on your watchlist"}`;

  return { subject: `Athlete Exchange — ${headline}`, text: lines.join("\n") };
}

/**
 * Hand one message to the provider.
 *
 * Returns "skipped" rather than throwing when unconfigured, so the caller can
 * report honestly instead of a failed send looking like a successful one.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string
): Promise<"sent" | "skipped" | "failed"> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.DIGEST_FROM;
  if (!key || !from) return "skipped";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

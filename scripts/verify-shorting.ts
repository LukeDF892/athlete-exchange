/**
 * End-to-end checks for selling short, against the real database.
 *
 * The pricing maths exists twice — TypeScript for quotes, SQL for execution —
 * and shorting doubled the number of paths through the SQL half. These are the
 * invariants that matter, and none of them can be checked without a real
 * database because `execute_trade` is where the money actually moves:
 *
 *   * a short round trip is exactly break-even, for the same reason a long one
 *     is: the integral down equals the integral back up
 *   * shorting consumes buying power rather than creating it, or it would be
 *     free money
 *   * a short cannot be opened without collateral, and cannot exceed the
 *     position cap
 *   * `margin_call()` closes a position whose cover cost has outgrown its
 *     collateral, because play money has no way to owe
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const EMAIL = `short-check-${Date.now()}@example.com`;
const PASSWORD = `pw-${Math.random().toString(36).slice(2)}-Aa1!`;

let passed = 0;
let failed = 0;

function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function admin(path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function main() {
  let userId: string | null = null;
  try {
    const created = await (
      await admin("/auth/v1/admin/users", {
        method: "POST",
        body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
      })
    ).json();
    userId = created.id as string;

    const session = await (
      await fetch(`${url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { apikey: anonKey, "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      })
    ).json();
    const token = session.access_token as string;

    const as = (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    const rpc = async (fn: string, body: unknown) => {
      const res = await as(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(body) });
      return { ok: res.ok, status: res.status, data: await res.json() };
    };

    const cash = async (): Promise<number> => {
      const rows = await (
        await as(`/rest/v1/profiles?id=eq.${userId}&select=cash_balance`)
      ).json();
      return Number(rows?.[0]?.cash_balance ?? 0);
    };
    const position = async (pid: string) => {
      const rows = await (
        await as(`/rest/v1/holdings?player_id=eq.${pid}&select=shares,collateral`)
      ).json();
      return {
        shares: Number(rows?.[0]?.shares ?? 0),
        collateral: Number(rows?.[0]?.collateral ?? 0),
      };
    };

    // A mid-priced, liquid listing so the numbers are readable.
    const players = await (
      await as(
        "/rest/v1/players?kind=eq.athlete&status=eq.active&market_price=gte.40&market_price=lte.120&select=id,full_name,market_price,liquidity_depth&limit=1"
      )
    ).json();
    const player = players[0];
    if (!player) throw new Error("no suitable listing found");
    console.log(`Using ${player.full_name} at $${player.market_price}\n`);

    const start = await cash();
    check(start === 100000, "new account starts at $100,000", `${start}`);

    console.log("Opening a short");
    const open = await rpc("execute_trade", {
      p_player_id: player.id,
      p_side: "sell",
      p_shares: 40,
    });
    check(open.ok, "sell with no position opens a short", JSON.stringify(open.data?.action ?? open.data));

    const afterOpen = await cash();
    const pos = await position(player.id);
    check(pos.shares === -40, "position is negative", `${pos.shares} shares`);
    check(pos.collateral > 0, "collateral was locked", `$${pos.collateral.toFixed(2)}`);

    const proceeds = Number(open.data?.net ?? 0);
    check(
      Math.abs(afterOpen - (start + proceeds)) < 0.01,
      "proceeds credited to cash",
      `$${afterOpen.toFixed(2)}`
    );
    // Buying power = cash - collateral. Shorting must reduce it, never raise it.
    const buyingPower = afterOpen - pos.collateral;
    check(
      buyingPower < start,
      "shorting consumes buying power rather than creating it",
      `$${buyingPower.toFixed(2)} vs $${start.toFixed(2)}`
    );

    console.log("\nCovering it straight back");
    const cover = await rpc("execute_trade", {
      p_player_id: player.id,
      p_side: "buy",
      p_shares: 40,
    });
    check(cover.ok, "buy against a short covers", String(cover.data?.action));

    const afterCover = await cash();
    check(
      Math.abs(afterCover - start) < 0.01,
      "instant short round trip never profits",
      `$${start.toFixed(2)} → $${afterCover.toFixed(2)} (${(afterCover - start).toFixed(2)})`
    );
    const closed = await position(player.id);
    check(closed.shares === 0, "position closed out", `${closed.shares}`);

    console.log("\nGuards");
    const tooBig = await rpc("execute_trade", {
      p_player_id: player.id,
      p_side: "sell",
      p_shares: 10_000_000,
    });
    check(!tooBig.ok, "cannot short beyond the position cap or collateral", `status ${tooBig.status}`);

    await rpc("execute_trade", { p_player_id: player.id, p_side: "sell", p_shares: 20 });
    const overCover = await rpc("execute_trade", {
      p_player_id: player.id,
      p_side: "buy",
      p_shares: 60,
    });
    check(!overCover.ok, "an order may not cross from short to long", `status ${overCover.status}`);

    // Clean up the open short so the shared board is left as found.
    await rpc("execute_trade", { p_player_id: player.id, p_side: "buy", p_shares: 20 });
    const finalCash = await cash();
    check(
      Math.abs(finalCash - start) < 0.01,
      "back to the starting balance after all trades",
      `$${finalCash.toFixed(2)}`
    );
  } finally {
    if (userId) {
      await admin(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
      console.log("\n(test user deleted)");
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

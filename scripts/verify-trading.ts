/**
 * End-to-end check of the trade path against the real database.
 *
 *   npm run verify:trading
 *
 * The unit tests cover the pricing maths in TypeScript. This covers the part
 * they cannot reach: that execute_trade() in Postgres agrees with them, that
 * money and shares actually move, and that the guard rails reject bad orders.
 *
 * It creates a disposable test user, trades as that user, and deletes it again
 * — so it leaves the market exactly as it found it.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { quoteBuy, quoteSell } from "@/lib/pricing/engine";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!url || !anonKey || !serviceKey) {
  throw new Error("Missing Supabase env vars — see .env.local.example");
}

const EMAIL = `verify-${Date.now()}@athlete-exchange.test`;
const PASSWORD = `verify-${Math.random().toString(36).slice(2)}-Aa1!`;

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  [32m✓[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  [31m✗[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Two money amounts agree.
 *
 * Default is half a cent, not a cent: SQL and TypeScript are supposed to round
 * identically, so anything that actually differs at the cent is a bug in the
 * rounding rule, not acceptable float noise. A looser tolerance here hid a real
 * one-cent disagreement on sells.
 */
function near(a: number, b: number, tol = 0.005) {
  return Math.abs(a - b) <= tol;
}

async function admin(path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function asUser(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return res;
}

async function main() {
  let userId: string | null = null;

  try {
    // ---- setup: disposable user -------------------------------------------
    const createRes = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
    });
    const created = await createRes.json();
    if (!createRes.ok) throw new Error(`Could not create test user: ${JSON.stringify(created)}`);
    userId = created.id;

    const signInRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const session = await signInRes.json();
    if (!signInRes.ok) throw new Error(`Could not sign in: ${JSON.stringify(session)}`);
    const token: string = session.access_token;

    console.log("\nSignup");
    const profRes = await asUser(token, `/rest/v1/profiles?id=eq.${userId}&select=*`);
    const [profile] = await profRes.json();
    check("profile auto-created by trigger", Boolean(profile));
    const startingCash = Number(profile?.cash_balance ?? 0);
    check("starts with $100,000", near(startingCash, 100_000), `$${startingCash.toLocaleString()}`);

    // ---- pick a mid-priced athlete ----------------------------------------
    const pRes = await asUser(
      token,
      "/rest/v1/players?select=*&order=market_price.desc&limit=1&offset=40"
    );
    const [player] = await pRes.json();
    if (!player) throw new Error("No players in database — run `npm run ingest -- --push`");

    const before = {
      shares: Number(player.shares_outstanding),
      fair: Number(player.fair_value),
      depth: Number(player.liquidity_depth),
      price: Number(player.market_price),
    };
    console.log(`\nTrading ${player.full_name} @ $${before.price.toFixed(2)}`);

    // ---- BUY ---------------------------------------------------------------
    const BUY = 10;
    const expectBuy = quoteBuy(before.fair, before.shares, BUY, before.depth);

    const buyRes = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "buy", p_shares: BUY }),
    });
    const buy = await buyRes.json();
    check("buy accepted", buyRes.ok, buyRes.ok ? "" : JSON.stringify(buy));

    if (buyRes.ok) {
      check(
        "SQL average fill matches TypeScript",
        near(Number(buy.avgPrice), expectBuy.avgPrice),
        `sql $${Number(buy.avgPrice).toFixed(4)} vs ts $${expectBuy.avgPrice.toFixed(4)}`
      );
      check(
        "SQL total cost matches TypeScript",
        near(Number(buy.net), expectBuy.net),
        `sql $${Number(buy.net).toFixed(4)} vs ts $${expectBuy.net.toFixed(4)}`
      );
      check(
        "SQL price-after matches TypeScript",
        near(Number(buy.priceAfter), expectBuy.priceAfter),
        `sql $${Number(buy.priceAfter).toFixed(4)} vs ts $${expectBuy.priceAfter.toFixed(4)}`
      );

      const [afterBuyProfile] = await (
        await asUser(token, `/rest/v1/profiles?id=eq.${userId}&select=cash_balance`)
      ).json();
      const cashAfter = Number(afterBuyProfile.cash_balance);
      check(
        "cash debited by exactly the quoted cost",
        near(cashAfter, startingCash - Number(buy.net)),
        `$${cashAfter.toFixed(2)}`
      );

      const [holding] = await (
        await asUser(
          token,
          `/rest/v1/holdings?user_id=eq.${userId}&player_id=eq.${player.id}&select=*`
        )
      ).json();
      check("holding created with 10 shares", Number(holding?.shares) === BUY);
      check(
        "average cost recorded",
        near(Number(holding?.avg_cost), Number(buy.avgPrice)),
        `$${Number(holding?.avg_cost).toFixed(4)}`
      );

      const [movedPlayer] = await (
        await asUser(token, `/rest/v1/players?id=eq.${player.id}&select=*`)
      ).json();
      check(
        "market price moved up",
        Number(movedPlayer.market_price) > before.price,
        `$${before.price.toFixed(2)} → $${Number(movedPlayer.market_price).toFixed(2)}`
      );
      check(
        "shares outstanding increased by 10",
        Number(movedPlayer.shares_outstanding) === before.shares + BUY
      );
      check(
        "liquidity depth unchanged",
        near(Number(movedPlayer.liquidity_depth), before.depth, 0.001)
      );

      const trades = await (
        await asUser(token, `/rest/v1/trades?user_id=eq.${userId}&select=*`)
      ).json();
      check("trade recorded in ledger", trades.length === 1);
    }

    // ---- guard rails --------------------------------------------------------
    console.log("\nGuard rails");

    const oversell = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "sell", p_shares: 999 }),
    });
    const oversellBody = await oversell.json();
    check(
      "cannot sell more than held",
      !oversell.ok,
      String(oversellBody.message ?? "").slice(0, 60)
    );

    const tooBig = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "buy", p_shares: 100000 }),
    });
    const tooBigBody = await tooBig.json();
    check("cannot buy beyond cash", !tooBig.ok, String(tooBigBody.message ?? "").slice(0, 60));

    const zero = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "buy", p_shares: 0 }),
    });
    check("rejects zero shares", !zero.ok);

    const negative = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "buy", p_shares: -5 }),
    });
    check("rejects negative shares", !negative.ok);

    // ---- SELL back ----------------------------------------------------------
    console.log("\nRound trip");
    const [nowPlayer] = await (
      await asUser(token, `/rest/v1/players?id=eq.${player.id}&select=*`)
    ).json();
    const expectSell = quoteSell(
      Number(nowPlayer.fair_value),
      Number(nowPlayer.shares_outstanding),
      BUY,
      Number(nowPlayer.liquidity_depth)
    );

    const sellRes = await asUser(token, "/rest/v1/rpc/execute_trade", {
      method: "POST",
      body: JSON.stringify({ p_player_id: player.id, p_side: "sell", p_shares: BUY }),
    });
    const sell = await sellRes.json();
    check("sell accepted", sellRes.ok, sellRes.ok ? "" : JSON.stringify(sell));

    if (sellRes.ok) {
      check(
        "SQL sell proceeds match TypeScript",
        near(Number(sell.net), expectSell.net),
        `sql $${Number(sell.net).toFixed(4)} vs ts $${expectSell.net.toFixed(4)}`
      );

      const [finalProfile] = await (
        await asUser(token, `/rest/v1/profiles?id=eq.${userId}&select=cash_balance`)
      ).json();
      const finalCash = Number(finalProfile.cash_balance);
      // Never a profit. With the fee at zero this is break-even; the curve,
      // not the fee, is what makes it impossible to come out ahead.
      check(
        "instant round trip never profits",
        finalCash <= startingCash + 0.01,
        `$${startingCash.toLocaleString()} → $${finalCash.toFixed(2)} (${(
          finalCash - startingCash
        ).toFixed(2)})`
      );

      const holdings = await (
        await asUser(
          token,
          `/rest/v1/holdings?user_id=eq.${userId}&player_id=eq.${player.id}&select=*`
        )
      ).json();
      check("position closed out", holdings.length === 0 || Number(holdings[0]?.shares) === 0);

      const [restored] = await (
        await asUser(token, `/rest/v1/players?id=eq.${player.id}&select=*`)
      ).json();
      check(
        "shares outstanding back to where it started",
        Number(restored.shares_outstanding) === before.shares,
        `${Number(restored.shares_outstanding)}`
      );
    }

    // ---- isolation ----------------------------------------------------------
    console.log("\nRow-level security");
    const otherRes = await asUser(token, `/rest/v1/profiles?select=id`);
    const others = await otherRes.json();
    check(
      "can only see own profile",
      Array.isArray(others) && others.length === 1,
      `${Array.isArray(others) ? others.length : "?"} row(s) visible`
    );

    const anonRead = await fetch(`${url}/rest/v1/holdings?select=*`, {
      headers: { apikey: anonKey },
    });
    const anonRows = await anonRead.json();
    check(
      "signed-out cannot read holdings",
      !Array.isArray(anonRows) || anonRows.length === 0,
      Array.isArray(anonRows) ? `${anonRows.length} rows` : "denied"
    );
  } finally {
    if (userId) {
      await admin(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
      console.log("\n(test user deleted)");
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nverification failed:", err.message);
  process.exit(1);
});

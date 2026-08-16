/**
 * Proves the profiles policy actually blocks what it claims to.
 *
 * Migration 0008 pinned `is_admin` on the self-update policy so nobody could
 * promote themselves, but left `cash_balance` writable — meaning a signed-in
 * user holding only the publishable key could set their own balance by calling
 * PostgREST directly, without ever touching the app. 0012 pins both.
 *
 * Reading the policy text is not proof: the SQL can look right and still let a
 * write through, because `with check` only runs on the rows an `update`
 * actually matches. So this drives the real HTTP endpoint with a real user
 * token, exactly the way an attacker would.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const EMAIL = `rls-check-${Date.now()}@example.com`;
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
  if (!url || !anonKey || !serviceKey) {
    throw new Error("Supabase keys missing — set them in .env.local");
  }

  let userId: string | null = null;
  try {
    const createRes = await admin("/auth/v1/admin/users", {
      method: "POST",
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
    });
    const created = await createRes.json();
    if (!createRes.ok) throw new Error(`Could not create user: ${JSON.stringify(created)}`);
    userId = created.id as string;

    const signInRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const session = await signInRes.json();
    if (!signInRes.ok) throw new Error(`Could not sign in: ${JSON.stringify(session)}`);
    const token = session.access_token as string;

    const asUser = (path: string, init: RequestInit = {}) =>
      fetch(`${url}${path}`, {
        ...init,
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(init.headers ?? {}),
        },
      });

    const startingCash = async (): Promise<number> => {
      const res = await asUser(`/rest/v1/profiles?id=eq.${userId}&select=cash_balance`);
      const rows = await res.json();
      return Number(rows?.[0]?.cash_balance ?? -1);
    };

    const before = await startingCash();
    check(before === 100000, "new account starts with $100,000", `got ${before}`);

    console.log("\nEscalation attempts (all must fail)");

    // The exact call migration 0012 exists to stop.
    const cashRes = await asUser(`/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ cash_balance: 1_000_000_000 }),
    });
    const afterCash = await startingCash();
    check(
      afterCash === 100000,
      "cannot set own cash_balance",
      `status ${cashRes.status}, balance now ${afterCash}`
    );

    const adminRes = await asUser(`/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ is_admin: true }),
    });
    const adminCheck = await admin(`/rest/v1/profiles?id=eq.${userId}&select=is_admin`);
    const adminRows = await adminCheck.json();
    check(
      adminRows?.[0]?.is_admin === false,
      "cannot grant self admin",
      `status ${adminRes.status}`
    );

    // Both at once, in case the policy only guards them individually.
    const bothRes = await asUser(`/rest/v1/profiles?id=eq.${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ cash_balance: 500_000, is_admin: true }),
    });
    const afterBoth = await startingCash();
    check(
      afterBoth === 100000,
      "cannot set cash and admin together",
      `status ${bothRes.status}, balance ${afterBoth}`
    );

    console.log("\nWhat a user IS allowed to change");

    const name = `renamed_${Math.random().toString(36).slice(2, 8)}`;
    const renameRes = await asUser("/rest/v1/rpc/set_username", {
      method: "POST",
      body: JSON.stringify({ p_username: name }),
    });
    const renamed = await renameRes.json();
    check(renameRes.ok && renamed === name, "can change own username", String(renamed));

    const badRes = await asUser("/rest/v1/rpc/set_username", {
      method: "POST",
      body: JSON.stringify({ p_username: "no spaces allowed!" }),
    });
    check(!badRes.ok, "rejects a malformed username", `status ${badRes.status}`);

    const stillCash = await startingCash();
    check(stillCash === 100000, "renaming did not disturb the balance", `${stillCash}`);
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

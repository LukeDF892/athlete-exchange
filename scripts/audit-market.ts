/**
 * `npm run audit:market` — the same checks the refresh cron runs, on demand.
 *
 * Exits non-zero on RED so it can gate a deploy.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { createClient } from "@supabase/supabase-js";
import { runAudit, formatAudit } from "@/lib/market/audit";

async function main() {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
  const result = await runAudit(db);
  console.log(formatAudit(result));
  if (result.level === "red") process.exit(1);
}

main().catch((e) => {
  console.error("audit failed:", e);
  process.exit(1);
});

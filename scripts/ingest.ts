/**
 * Command-line entry point for the ingest.
 *
 *   npm run ingest             -> rebuild data/snapshot.json
 *   npm run ingest -- --push   -> also upsert into Supabase
 *
 * The work itself lives in lib/ingest/run.ts so the scheduled refresh route can
 * call exactly the same code path.
 */
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

import { runIngest } from "@/lib/ingest/run";

runIngest({ push: process.argv.includes("--push") }).catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});

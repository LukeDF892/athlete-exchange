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

import type { Sport } from "@/lib/pricing/engine";
import { runIngest } from "@/lib/ingest/run";

/**
 * `--sports nfl,nba` restricts the run, which is what the scheduled refresh
 * does one league at a time. Leagues left out are carried forward, not dropped.
 */
const sportsArg = process.argv.indexOf("--sports");
const sports =
  sportsArg >= 0 && process.argv[sportsArg + 1]
    ? (process.argv[sportsArg + 1].split(",").map((s) => s.trim()) as Sport[])
    : undefined;

runIngest({ push: process.argv.includes("--push"), sports }).catch((err) => {
  console.error("ingest failed:", err);
  process.exit(1);
});

import { nbaProvider } from "@/lib/providers/espn";
import { fairValue, liquidityDepth, marketPrice } from "@/lib/pricing/engine";

async function main() {
  const ids = await nbaProvider.listPlayerIds(2000);
  console.log("nba roster ids:", ids.length);
  const sample = ids.slice(0, 6);
  for (const id of sample) {
    const pl = await nbaProvider.fetchPlayer(id);
    if (!pl) { console.log(id, "-> null (no season stats)"); continue; }
    const fv = fairValue({ sport: "nba", recent: pl.recent, season: pl.season, career: pl.career, ageYears: pl.ageYears });
    console.log(
      `${pl.fullName.padEnd(24)} ${String(pl.position).padEnd(3)} ${String(pl.teamAbbrev).padEnd(4)} age ${String(pl.ageYears).padEnd(5)} FV $${String(fv).padEnd(7)} open $${marketPrice(fv,0,liquidityDepth(fv))}`
    );
    console.log("   season:", pl.statTables[0].rows.map(r=>`${r.label} ${r.value}`).join("  "));
  }
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });

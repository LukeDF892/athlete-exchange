import { NhlProvider } from "@/lib/providers/nhl";
import { fairValue, liquidityDepth, marketPrice } from "@/lib/pricing/engine";

async function main() {
  const p = new NhlProvider();
  const ids = await p.listPlayerIds(1000);
  console.log("roster ids:", ids.length);

  for (const id of ["8478402", "8477934", "8471675", "8480313"]) {
    const pl = await p.fetchPlayer(id);
    if (!pl) { console.log(id, "-> null"); continue; }
    const fv = fairValue({ sport: "nhl", recent: pl.recent, season: pl.season, career: pl.career, ageYears: pl.ageYears });
    console.log(
      `${pl.fullName.padEnd(20)} ${String(pl.position).padEnd(2)} ${String(pl.teamAbbrev).padEnd(4)} age ${String(pl.ageYears).padEnd(5)} FV $${String(fv).padEnd(7)} open $${marketPrice(fv, 0, liquidityDepth(fv))} tables:${pl.statTables.length}`
    );
  }
  console.log("gamelog:", (await p.fetchGameLog("8478402", 2))[0]);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });

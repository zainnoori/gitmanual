// Deep Inspection reports made ahead of time for the most-viewed manuals, so the free preview on those manuals
// (app/report.tsx InspectionStrip) shows real results. Skips repos with a fresh report of the current version.
// Paid from its own budget pool (lib/budget.ts "inspectionPrerun": 300 a day, $3 a day at most, Haiku).
//
//   npm run inspect:top                  → the top 200 by views, against the database in .env.local (local by default)
//   npm run inspect:top -- --top 50      → fewer
//   npm run inspect:top -- --dry         → only list what it would inspect
//
// To fill production, run it with production's TURSO_DATABASE_URL / TURSO_AUTH_TOKEN set in your own shell.
// Uses GITHUB_TOKEN for GitHub (about 30 calls a repo) and ANTHROPIC_API_KEY for the wording.
import { strictly } from "../lib/db";
import { parseRepoUrl } from "../lib/github";
import { build, FRESH_MS, VERSION } from "../lib/inspection";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? null : (process.argv[i + 1] ?? "");
};
const top = Math.min(1000, Math.max(1, Number(arg("top") ?? 200) || 200));
const dry = process.argv.includes("--dry");

if (!process.env.GITHUB_TOKEN) console.warn("GITHUB_TOKEN isn't set: GitHub allows 60 calls an hour without it, enough for about two repos.");
if (!process.env.ANTHROPIC_API_KEY) console.warn("ANTHROPIC_API_KEY isn't set: reports are made from the rules alone, without Claude's wording.");
console.log(`Database: ${process.env.TURSO_DATABASE_URL?.startsWith("libsql:") ? "Turso (remote)" : "local file"}`);

async function main() {
  const rows = await strictly(async (c) =>
    (
      await c.execute({
        sql: `SELECT r.full_name AS name FROM repos r
              LEFT JOIN inspections i ON i.key = r.key AND i.version = ? AND i.scanned_at > ?
              WHERE i.key IS NULL AND r.full_name NOT LIKE '%@%'
              ORDER BY r.views DESC, r.stars DESC LIMIT ?`,
        args: [VERSION, Date.now() - FRESH_MS, top],
      })
    ).rows.map((r) => String(r.name)),
  );

  console.log(`${rows.length} of the top ${top} need a report${dry ? " (dry run)" : ""}.`);
  if (dry) {
    rows.forEach((r) => console.log(`  ${r}`));
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const [i, name] of rows.entries()) {
    const ref = parseRepoUrl(name);
    if (!ref) continue;
    const t = Date.now();
    try {
      const r = await build(ref, "prerun", "inspectionPrerun");
      ok++;
      console.log(`${i + 1}/${rows.length} ${name}: ${r.grades.overall ?? "-"} in ${Math.round((Date.now() - t) / 1000)}s`);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`${i + 1}/${rows.length} ${name}: failed (${msg})`);
      // The day's budget is used up, or GitHub is refusing: stop, run again later (finished repos are skipped).
      if (/paused|fair-use|rate limit|API rate/i.test(msg)) break;
    }
  }
  console.log(`Done: ${ok} made, ${failed} failed.`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);

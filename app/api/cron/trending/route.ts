import { NextResponse } from "next/server";
import { getCached, hasRepo, markRising, repoKey } from "@/lib/db";
import { risingRepos, topicRepos } from "@/lib/github";
import { SEED_THEMES } from "@/lib/lists";
import { loadRepo } from "@/lib/pipeline";

export const maxDuration = 300;

// New repos per run: about 4 GitHub API calls each, well inside the 5,000/hour token, and done in a few minutes.
const PER_RUN = 15;
// Then up to this many well-known repos for one list theme (a different one each day), so the lists fill up.
const PER_THEME = 10;

const known = (full: string) => hasRepo(full.toLowerCase());

// Each repo gets at most a minute, and no new one starts after 200 s, so the run ends well inside the 300 s limit
// even when GitHub or the database is slow (2026-11-17: requests hung until Vercel killed them).
const PER_REPO_MS = 60_000;
const STOP_AFTER_MS = 200_000;
const within = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error(`gave up after ${ms / 1000} s`)), ms))]);

// Daily (vercel.json): adds manuals for repos that are rising on GitHub right now, so the shelf, the sitemap and
// search engines get them while people are searching for them. Repos already on the shelf are left alone.
// Then it adds the most-starred repos for one list theme that aren't on the shelf yet (not marked rising).
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<site>/api/cron/trending
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const started = Date.now();
  const timeLeft = () => Date.now() - started < STOP_AFTER_MS;
  let candidates: string[];
  try {
    candidates = await risingRepos(40);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }

  const added: string[] = [];
  const failed: { repo: string; error: string }[] = [];
  let knownCount = 0;
  for (const full of candidates) {
    if (added.length >= PER_RUN || !timeLeft()) break;
    const [owner, repo] = full.split("/");
    // Already on the shelf: it's still rising, so it counts for "Rising this week" too.
    if (await getCached(repoKey(owner, repo))) {
      knownCount++;
      await markRising(repoKey(owner, repo));
      continue;
    }
    try {
      const { key } = await within(loadRepo({ owner, repo }), PER_REPO_MS);
      await markRising(key);
      added.push(full);
    } catch (e) {
      failed.push({ repo: full, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // One theme a day, in turn. A failed search only skips this part; the rising repos above are already saved.
  const theme = SEED_THEMES[Math.floor(Date.now() / 864e5) % SEED_THEMES.length];
  const seeded: string[] = [];
  if (theme && timeLeft()) {
    try {
      for (const full of await topicRepos(theme.topics, PER_THEME, known)) {
        if (!timeLeft()) break;
        const [owner, repo] = full.split("/");
        try {
          await within(loadRepo({ owner, repo }), PER_REPO_MS);
          seeded.push(full);
        } catch (e) {
          failed.push({ repo: full, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      failed.push({ repo: `topics:${theme.id}`, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return NextResponse.json({ candidates: candidates.length, known: knownCount, added, theme: theme?.id, seeded, failed });
}

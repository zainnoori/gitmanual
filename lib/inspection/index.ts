import { randomUUID } from "node:crypto";
import { BudgetError, PRICES, release, reserve, settle, type PoolName } from "../budget";
import { getInspection, hasRepo, repoKey, saveInspection } from "../db";
import { paidAiServices } from "../facts";
import type { RepoRef } from "../github";
import { loadRepo } from "../pipeline";
import { aiReview, MAX_OUTPUT, MAX_PROMPT_TOKENS, MODEL, prompt, type Dispute } from "./ai";
import { collect, DEP_CAP, type Facts } from "./collect";
import { finish, findings, grades, headline } from "./rules";
import { directDeps, setupFindings } from "./setup";
import type { Coverage, Decision, Finding, Inspection, Scope } from "./types";

// Deep Inspection for one repo: the saved report while it's fresh, a new one otherwise. Shared by every Pro member,
// so a repo is inspected at most once every few days however many people open it. Only repos already on gitmanual
// can be inspected. Each new report counts toward the account's daily allowance (lib/budget.ts "inspection") and
// pays for its Claude call from that pool.

export const VERSION = 3; // raise when rules change, so saved reports are rebuilt
export const FRESH_MS = 3 * 24 * 60 * 60 * 1000;
export const RESCAN_MS = 60 * 60 * 1000;

export class InspectionError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

// What's shown for sources that didn't answer, in the words the page uses.
const UNAVAILABLE: Record<string, string> = {
  owner: "The owner's profile",
  languages: "Languages",
  activity: "Weekly activity (GitHub was still counting it)",
  releases: "Releases",
  contributors: "Contributors",
  community: "GitHub's community profile",
  files: "The file list",
  "file contents": "Some files",
  "discussions and contributors": "Issues, pull requests and recent commits",
  "security advisories": "Security advisories",
  "security score": "OpenSSF Scorecard (it hasn't scanned this repo)",
  dependencies: "The dependency list",
  packages: "Package downloads",
  "star check": "Whether its stars look bought",
  "star history": "Stars over time",
  "whole repo": "The whole repo (too large to download), so only its main files were read",
  ci: "CI results",
};

// Without Claude, the summary is built from the findings: the description, what it needs, the top concerns.
const PRIORITY = { blocker: 0, important: 1, improvement: 2 } as const;
export function plainDecision(f: Facts, all: Finding[]): Decision {
  const concerns = all.filter((x) => x.status === "concern" && x.priority).sort((a, b) => PRIORITY[a.priority!] - PRIORITY[b.priority!]);
  const needs = all.filter((x) => ["requirements.summary", "services.accounts", "services.ok", "services.missing"].includes(x.id)).map((x) => x.text);
  return {
    does: `${f.repo.description ? `${f.repo.description.replace(/\.?\s*$/, ".")} ` : ""}Claude's summary wasn't available for this report, so this one is built from the checks below.`,
    needs,
    blockers: concerns.filter((x) => x.priority !== "improvement").slice(0, 4).map((x) => x.title),
    first: concerns.filter((x) => x.action).slice(0, 3).map((x) => x.action!),
    business: all.find((x) => x.id === "license.obligations")?.text.replace(/^.*For a business: /, "") ?? "",
  };
}

// Claude found, with quotes from the files, that a rule's finding doesn't hold (Navidrome migrates at startup): it
// stays visible, downgraded to an improvement, with Claude's reason and quotes beside it.
export function applyDisputes(found: Finding[], disputes: Dispute[]): Finding[] {
  return found.map((x) => {
    const d = disputes.find((y) => y.id === x.id);
    if (!d || x.status === "pass") return x;
    return {
      ...x,
      level: "note",
      status: "concern",
      priority: x.priority ? "improvement" : x.priority,
      title: `${x.title} (likely a false alarm)`,
      text: `${x.text} Claude's reading of the files disagrees: ${d.reason}`,
      quote: d.quote,
      evidence: [...(x.evidence ?? []), ...(d.evidence ?? [])],
    };
  });
}

const MANIFEST = /(^|\/)(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|Gemfile|composer\.json|requirements[\w.-]*\.txt)$/;
function coverage(facts: Facts, files: { files: Record<string, string>; paths: string[] }): Coverage {
  const oldest = (xs: string[]) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a)) : null);
  const manifests = files.paths.filter((p) => MANIFEST.test(p) && !/(^|\/)(node_modules|vendor)\//.test(p));
  return {
    listComplete: Boolean(facts.archive) || !facts.treeTruncated,
    manifests: { found: manifests.length, read: manifests.filter((p) => p in files.files).length },
    deps: facts.deps ? { total: facts.deps.total, checked: facts.deps.checked, cap: DEP_CAP } : null,
    commits: facts.recentCommits ? { count: facts.recentCommits.length, since: oldest(facts.recentCommits.map((c) => c.date)) } : null,
    issues: facts.threads ? { count: facts.threads.issues.length, since: oldest(facts.threads.issues.map((t) => t.createdAt)) } : null,
    releases: facts.releases?.length ?? null,
    executed: false,
  };
}

export async function build(ref: RepoRef, account: string, pool: PoolName = "inspection"): Promise<Inspection> {
  const key = repoKey(ref.owner, ref.repo);
  // Held before anything is fetched: the most this report's Claude call can cost (about 3 characters a token).
  const price = PRICES[MODEL];
  const worst = Math.ceil(MAX_PROMPT_TOKENS * price.input + MAX_OUTPUT * price.output);
  let reservation;
  try {
    reservation = await reserve({ pool, account, requestId: randomUUID(), model: MODEL, repo: key, amount: worst });
  } catch (e) {
    if (!(e instanceof BudgetError)) throw e;
    const message =
      e.reason === "answers"
        ? "You've run 50 new inspections today, the fair-use limit. Saved reports still open; new ones resume at midnight UTC."
        : e.reason === "busy"
          ? "Two inspections are already running for you. Wait for one to finish."
          : "New inspections are paused for now. Saved reports still open.";
    throw new InspectionError(message, e.reason === "unavailable" ? 503 : 429, e.retryAfter);
  }
  if (reservation.duplicate) throw new InspectionError("This inspection is already running.", 409);

  let spent = false;
  try {
    const [facts, manual] = await Promise.all([collect(ref), loadRepo(ref).catch(() => null)]);
    const paidAi = manual ? paidAiServices(manual.data.analysis.envVars) : [];
    const ref2 = facts.commit ?? facts.repo.defaultBranch;
    const link = (path: string, line?: number) => `${facts.repo.htmlUrl}/blob/${ref2}/${path.split("/").map(encodeURIComponent).join("/")}${line ? `#L${line}` : ""}`;
    const files = facts.archive ? { files: facts.archive.files, paths: facts.archive.paths, whole: true } : { files: facts.texts, paths: facts.paths, whole: false };
    const setup = setupFindings({ facts, files, link });
    // Which flawed packages its own manifests list (and as development tools); the rest come in through others.
    // Only known when the manifests were read: otherwise left out, and shown as unknown.
    if (facts.deps && files.whole) {
      const own = directDeps(files);
      for (const v of facts.deps.vulnerable) {
        const d = own.get(v.name.toLowerCase());
        v.scope = d ? (d.dev ? "dev" : "direct") : "indirect";
      }
    }
    let found = [...setup.findings, ...findings(facts, { paidAi, requested: `${ref.owner}/${ref.repo}` })];
    // The setup check reads the code for the accounts it needs; that replaces the rougher guesses from settings files.
    if (found.some((x) => x.id === "services.accounts")) found = found.filter((x) => x.id !== "cost.services" && x.id !== "cost.ai");
    // Checks that don't fit the kind of project: a library or extension isn't installed from GitHub release files,
    // and a tool installed from releases isn't broken by a failing check on its latest code.
    const kindOf = setup.kind.kind;
    if (["library", "extension", "plugin", "docs", "template"].includes(kindOf)) found = found.filter((x) => x.id !== "releases.signed");
    found = found.map(finish);
    if (["cli", "desktop", "mobile"].includes(kindOf) && facts.releases?.length)
      found = found.map((x) => (x.id === "tests.result" && x.priority === "important" ? { ...x, priority: "improvement", text: `${x.text} Most people install a release rather than the latest code.` } : x));
    // The setup check says which flawed packages it uses directly; that one carries the priority.
    if (found.some((x) => x.id === "deps.direct")) found = found.map((x) => (x.id === "deps.vulns" && x.priority ? { ...x, priority: "improvement" } : x));
    let decision: Decision = plainDecision(facts, found);
    let architecture: Inspection["architecture"] = null;
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        // Sized check: the prompt mustn't outgrow what was reserved for it (about 3 characters a token).
        if (prompt(facts, found, setup.kind, files.files, files.paths).length / 3 <= MAX_PROMPT_TOKENS) {
          const ai = await aiReview(facts, found, { files: files.files, paths: files.paths, kind: setup.kind, link });
          spent = true;
          // Settled either way, at what it actually used, so the hold never lingers as "already running".
          await settle(reservation.key, MODEL, [ai.usage]);
          if ("failed" in ai) console.error(`inspection ai: unusable answer (${ai.failed}) for ${key}`);
          else {
            decision = ai.decision;
            architecture = ai.architecture;
            found = [...applyDisputes(found, ai.disputes), ...ai.findings.map(finish)];
          }
        }
      } catch (e) {
        console.error("inspection ai:", e);
      }
    }
    const scope: Scope = {
      branch: facts.repo.defaultBranch,
      commit: facts.commit ?? null,
      archive: Boolean(facts.archive),
      filesInRepo: files.paths.length,
      filesRead: Object.keys(files.files).length,
      skipped: facts.archive?.skipped ?? [],
      coverage: coverage(facts, files),
    };
    if (!spent) await release(reservation.key);
    const report: Inspection = {
      version: VERSION,
      repo: facts.repo.fullName,
      scannedAt: facts.collectedAt,
      // The files themselves aren't kept: the findings and their quotes say what mattered in them.
      facts: { ...facts, texts: {}, paths: [], archive: null, fileCount: files.paths.length },
      findings: found,
      headline: headline(found),
      summary: null,
      decision,
      architecture,
      steps: setup.steps,
      kind: setup.kind,
      scope,
      grades: grades(found),
      unavailable: Object.keys(facts.unavailable).map((k) => UNAVAILABLE[k] ?? k),
    };
    const year = facts.weeks?.reduce((a, b) => a + b, 0) ?? null;
    await saveInspection(key, VERSION, report, report.scannedAt, {
      grade: report.grades.overall,
      stars: facts.repo.stars,
      commitsYear: year,
      vulnerable: facts.deps?.vulnerable.length ?? null,
      contributors: facts.contributors?.length ?? null,
    });
    return report;
  } catch (e) {
    if (!spent) await release(reservation.key);
    if (e instanceof InspectionError) throw e;
    throw new InspectionError(e instanceof Error ? e.message : "The inspection failed. Try again in a minute.", 502);
  }
}

export type Loaded = { inspection: Inspection; fresh: boolean };

// The saved report if there is one (fresh or not), without building anything.
export async function saved(ref: RepoRef): Promise<Loaded | null> {
  const s = await getInspection(repoKey(ref.owner, ref.repo));
  if (!s || s.version !== VERSION) return null;
  return { inspection: s.data as Inspection, fresh: Date.now() - s.scannedAt < FRESH_MS };
}

// The report to show: saved and fresh, or built now. `rescan` builds a new one even when a fresh one is saved.
export async function inspect(ref: RepoRef, account: string, opts: { rescan?: boolean } = {}): Promise<Loaded> {
  if (ref.ref) throw new InspectionError("Deep Inspection looks at a repo's main branch only.", 400);
  if (!(await hasRepo(repoKey(ref.owner, ref.repo)))) throw new InspectionError("Open this repo's manual on gitmanual first, then inspect it.", 404);
  const s = await saved(ref);
  // A rescan of a report less than an hour old just returns it: nothing can have changed much, and it saves a scan.
  const recent = s && Date.now() - s.inspection.scannedAt < RESCAN_MS;
  if (s?.fresh && (!opts.rescan || recent)) return s;
  return { inspection: await build(ref, account), fresh: true };
}

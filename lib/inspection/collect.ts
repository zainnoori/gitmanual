import { getContributors, getFiles, getHeadSha, getTree, ghApi, ghCount, ghGraphql, type RepoRef, type TreeEntry } from "../github";
import { download, type Snapshot } from "./archive";

// Every fact Deep Inspection works from, gathered in parallel. Each source has its own time limit, and one that fails
// or times out is listed in `unavailable` instead of failing the inspection: the report says what it couldn't check.
// About 15 GitHub calls, one GraphQL query, raw file reads (not counted against GitHub's API limit), and a few free
// public services (OpenSSF Scorecard, OSV.dev, deps.dev, package registries).

export type Thread = {
  createdAt: string;
  closedAt: string | null;
  mergedAt?: string | null;
  bot: boolean; // opened by a bot (Dependabot and the like): left out of reply times
  firstReply: { at: string; maintainer: boolean } | null; // the first answer from a person other than the author
  maintainerReply?: string | null; // when an owner, member or collaborator first answered (not the author)
  botReply?: boolean; // a bot commented (left out of the replies above)
};

// One advisory affecting a package: what it is, how bad, and the first version that fixes it for what's installed.
export type Advisory = { id: string; aliases: string[]; summary: string | null; severity: string | null; fixed: string | null };

export type Facts = {
  collectedAt: number;
  repo: {
    fullName: string;
    description: string | null;
    htmlUrl: string;
    homepage: string | null;
    defaultBranch: string;
    createdAt: string;
    pushedAt: string;
    archived: boolean;
    fork: boolean;
    parent: string | null; // the repo it was forked from
    stars: number;
    forks: number;
    watchers: number;
    openIssues: number; // GitHub's count includes pull requests
    sizeKb: number;
    topics: string[];
    licenseSpdx: string | null; // GitHub's id; "NOASSERTION" when it found a license it couldn't name
    licenseName: string | null;
    hasIssues: boolean;
    hasDiscussions: boolean;
    isTemplate?: boolean; // marked as a template on GitHub ("Use this template")
  };
  owner: { login: string; type: "User" | "Organization"; createdAt: string | null; verified: boolean | null; name: string | null; company: string | null; followers: number | null } | null;
  languages: Record<string, number> | null; // bytes per language
  weeks: number[] | null; // commits per week, the last 52, oldest first
  // sums: the release notes list checksums, or GitHub shows a digest for its files.
  releases: { tag: string; date: string; prerelease: boolean; author: string | null; assets: string[]; sums?: boolean }[] | null;
  contributors: { login: string; commits: number }[] | null; // people only, most commits first (the top 100)
  contributorCount?: number | null; // everyone GitHub counts, including commits not linked to an account
  community: { health: number; files: Record<string, boolean> } | null; // GitHub's community profile
  paths: string[]; // every file in the repo (emptied once the report is made; fileCount stays)
  fileCount?: number;
  treeTruncated: boolean;
  texts: Record<string, string>; // the files read: license, README, contributing, security, manifests, settings examples
  threads: { issues: Thread[]; prs: Thread[] } | null; // the latest 50 of each
  stargazers: { starredAt: string; accountCreatedAt: string; followers: number; repos: number }[] | null; // the latest 100 (not read yet: see collect)
  forksTop: { name: string; stars: number; pushedAt: string }[] | null;
  recentCommits: { login: string | null; date: string }[] | null; // the latest 100 on the default branch
  licenseHistory: { date: string; message: string }[] | null; // commits that changed the license file
  funding: { platform: string; url: string }[] | null;
  advisories: { id: string; cve: string | null; severity: string; summary: string; published: string; url: string }[] | null;
  scorecard: { score: number; date: string; checks: { name: string; score: number; reason: string }[] } | null;
  deps: {
    total: number;
    checked: number; // with an exact version, so OSV could check them
    // One entry per package, with every flawed version found (a repo can have several lock files), worst first.
    // severity and summary are the worst advisory's; scope is filled in from the repo's manifests (index.ts).
    vulnerable: {
      name: string; versions: string[]; ecosystem: string; ids: string[]; severity: string | null; summary: string | null;
      advisories?: Advisory[];
      scope?: "direct" | "dev" | "indirect";
    }[];
    advisoriesShown?: number; // advisories looked up in detail (at most ADVISORY_CAP)
  } | null;
  // Stars over time, from GitHub's weekly star history (capped is kept for older saved reports; always false now).
  // weekly: stars gained each week from the first star (start is that week's Sunday), for the per-week view.
  starHistory?: { points: { date: string; stars: number }[]; capped: boolean; weekly?: { start: string; gains: number[] } } | null;
  packages: { system: string; name: string; version: string | null; downloadsMonth: number | null; dependents: number | null }[] | null;
  unavailable: Record<string, string>; // source → why
  commit?: string | null; // the commit everything was read at
  // GitHub's check results for that commit, or the latest runs on the branch when the commit has none.
  ci?: { source: "commit" | "branch"; runs: { name: string; conclusion: string | null; url: string }[] } | null;
  archive?: Snapshot | null; // the whole repo (not saved with the report)
};

const SECONDS = 1000;
export const DEP_CAP = 1000; // dependencies checked against OSV.dev, at most
const timeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("took too long")), ms))]);

const isBot = (login?: string | null, kind?: string | null) => kind === "Bot" || /\[bot\]$|-bot$|^dependabot|^renovate/i.test(login ?? "");

// Files worth reading for the findings, by path. Manuals already read the build files; these are the ones about
// rights, rules, money and data. Kept small: the README and license only need their first part.
const READ = [
  /^(LICEN[CS]E|COPYING|LICEN[CS]E[-_.][\w.-]+|COPYING[-_.][\w.-]+|NOTICE)(\.(md|txt|rst))?$/i,
  /^(README)(\.(md|rst|txt|markdown))?$/i,
  /^(\.github\/|docs\/)?(CONTRIBUTING|SECURITY|GOVERNANCE|MAINTAINERS|CODEOWNERS|CLA|FUNDING|PRIVACY|TELEMETRY)(\.(md|txt|rst|ya?ml))?$/i,
  /^\.github\/(FUNDING\.ya?ml|dco\.ya?ml|CODEOWNERS)$/i,
  /^(\.clabot|cla\.json|\.cla\.json)$/i,
  /^(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/i,
  /^(\.env\.example|\.env\.sample|\.env\.template|example\.env|env\.example)$/i,
  /^docs?\/.*(telemetry|privacy|analytics|usage-data|data-collection)[^/]*\.(md|mdx|rst|txt)$/i,
  /^\.github\/workflows\/[^/]+\.ya?ml$/i,
];
const MAX_READ = 40;
const MAX_CHARS = 60_000;

const GRAPHQL = `query($owner: String!, $name: String!, $license: String!, $withLicense: Boolean!) {
  repository(owner: $owner, name: $name) {
    fundingLinks { platform url }
    issues(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { createdAt closedAt author { login __typename } comments(first: 8) { nodes { createdAt authorAssociation author { login __typename } } } }
    }
    pullRequests(first: 50, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        createdAt closedAt mergedAt author { login __typename }
        comments(first: 6) { nodes { createdAt authorAssociation author { login __typename } } }
        reviews(first: 4) { nodes { createdAt authorAssociation author { login __typename } } }
      }
    }
    forks(first: 5, orderBy: { field: STARGAZERS, direction: DESC }) { nodes { nameWithOwner stargazerCount pushedAt } }
    defaultBranchRef {
      target {
        ... on Commit {
          recent: history(first: 100) { nodes { committedDate author { user { login } } } }
          license: history(first: 40, path: $license) @include(if: $withLicense) { nodes { committedDate messageHeadline } }
        }
      }
    }
  }
}`;

type Author = { login: string; __typename: string } | null;
type GqlReply = { createdAt: string; authorAssociation: string; author: Author };
type Gql = {
  repository: {
    fundingLinks: { platform: string; url: string }[];
    issues: { nodes: { createdAt: string; closedAt: string | null; author: Author; comments: { nodes: GqlReply[] } }[] };
    pullRequests: {
      nodes: { createdAt: string; closedAt: string | null; mergedAt: string | null; author: Author; comments: { nodes: GqlReply[] }; reviews: { nodes: GqlReply[] } }[];
    };
    forks: { nodes: { nameWithOwner: string; stargazerCount: number; pushedAt: string }[] };
    defaultBranchRef: {
      target: { recent?: { nodes: { committedDate: string; author: { user: { login: string } | null } | null }[] }; license?: { nodes: { committedDate: string; messageHeadline: string }[] } };
    } | null;
  } | null;
};

const MAINTAINER = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

function thread(t: { createdAt: string; closedAt: string | null; mergedAt?: string | null; author: Author }, replies: GqlReply[]): Thread {
  const author = t.author?.login ?? null;
  const people = replies
    .filter((r) => r.author && r.author.login !== author && !isBot(r.author.login, r.author.__typename))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const first = people[0];
  return {
    createdAt: t.createdAt,
    closedAt: t.closedAt,
    ...(t.mergedAt !== undefined && { mergedAt: t.mergedAt }),
    bot: isBot(author, t.author?.__typename),
    firstReply: first ? { at: first.createdAt, maintainer: MAINTAINER.has(first.authorAssociation) } : null,
    maintainerReply: people.find((r) => MAINTAINER.has(r.authorAssociation))?.createdAt ?? null,
    botReply: replies.some((r) => r.author && isBot(r.author.login, r.author.__typename)),
  };
}

async function json<T>(url: string, init: RequestInit = {}, ms = 10 * SECONDS): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, headers: { "User-Agent": "gitmanual (https://gitmanual.com)", ...(init.headers ?? {}) }, cache: "no-store", signal: AbortSignal.timeout(ms) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

// OpenSSF Scorecard's published results; repos it hasn't scanned have none.
async function scorecard(fullName: string): Promise<Facts["scorecard"]> {
  const j = await json<{ date: string; score: number; checks: { name: string; score: number; reason: string }[] }>(`https://api.securityscorecards.dev/projects/github.com/${fullName}`);
  return j && typeof j.score === "number" ? { score: j.score, date: j.date, checks: (j.checks ?? []).map((c) => ({ name: c.name, score: c.score, reason: c.reason })) } : null;
}

// The repo's dependency list from GitHub (its SBOM), checked against OSV.dev for known vulnerabilities. Only exact
// versions can be checked; ranges ("^1.2.0" in a manifest without a lock file) are counted but not looked up.
const purlVersion = (purl: string) => purl.match(/@([^?#]+)/)?.[1] ?? null;
const ADVISORY_CAP = 150;
type OsvVuln = {
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
};
const SEV: Record<string, number> = { CRITICAL: 0, HIGH: 1, MODERATE: 2, MEDIUM: 2, LOW: 3 };
const sevRank = (s: string | null) => SEV[s ?? ""] ?? 4;
// Compares dotted versions number by number ("1.10.0" > "1.9.2"); a pre-release tail counts as lower.
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/, "").split(/[.+-]/);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === undefined) return q !== undefined && /^\d+$/.test(q) ? -1 : 1;
    if (q === undefined) return /^\d+$/.test(p) ? 1 : -1;
    const [m, n] = [Number(p), Number(q)];
    if (!Number.isNaN(m) && !Number.isNaN(n)) {
      if (m !== n) return m - n;
    } else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}
// The lowest fixed version above the highest installed one, for this package. Null when the advisory names none.
export function fixedFor(d: OsvVuln, name: string, installed: string[]): string | null {
  const top = [...installed].sort(compareVersions).at(-1) ?? "0";
  const fixes = (d.affected ?? [])
    .filter((a) => a.package?.name?.toLowerCase() === name.toLowerCase())
    .flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((x): x is string => Boolean(x))))
    .filter((v) => compareVersions(v, top) > 0)
    .sort(compareVersions);
  return fixes[0] ?? null;
}
async function dependencies(fullName: string): Promise<Facts["deps"]> {
  const sbom = await ghApi<{ sbom: { name: string; packages: { name: string; versionInfo?: string; externalRefs?: { referenceType: string; referenceLocator: string }[] }[] } }>(
    `/repos/${fullName}/dependency-graph/sbom`,
    { timeoutMs: 15 * SECONDS },
  );
  if (!sbom.data) return null;
  const pkgs = sbom.data.sbom.packages
    .map((p) => ({ name: p.name, purl: p.externalRefs?.find((r) => r.referenceType === "purl")?.referenceLocator ?? null }))
    .filter((p) => p.purl && !p.purl.startsWith("pkg:github/")); // the repo itself and its GitHub Actions
  const exact = pkgs.filter((p) => {
    const v = purlVersion(p.purl!);
    return v && /^v?\d[\w.+-]*$/.test(decodeURIComponent(v));
  });
  const checked = exact.slice(0, DEP_CAP);
  const vulnerable: NonNullable<Facts["deps"]>["vulnerable"] = [];
  if (checked.length) {
    const r = await json<{ results: { vulns?: { id: string }[] }[] }>(
      "https://api.osv.dev/v1/querybatch",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: checked.map((p) => ({ package: { purl: p.purl } })) }) },
      15 * SECONDS,
    );
    if (!r) return { total: pkgs.length, checked: 0, vulnerable: [] };
    const byPackage = new Map<string, NonNullable<Facts["deps"]>["vulnerable"][number]>();
    r.results.forEach((res, i) => {
      if (!res.vulns?.length) return;
      const p = checked[i];
      const eco = p.purl!.match(/^pkg:([^/]+)\//)?.[1] ?? "";
      const name = p.name.replace(/^[^:]+:/, "");
      const version = decodeURIComponent(purlVersion(p.purl!) ?? "");
      const seen = byPackage.get(`${eco}:${name}`);
      if (seen) {
        if (!seen.versions.includes(version)) seen.versions.push(version);
        for (const v of res.vulns) if (!seen.ids.includes(v.id)) seen.ids.push(v.id);
      } else byPackage.set(`${eco}:${name}`, { name, versions: [version], ecosystem: eco, ids: res.vulns.map((v) => v.id), severity: null, summary: null });
    });
    vulnerable.push(...byPackage.values());
    // Every advisory in detail, up to a cap, a few at a time: what it is, how bad, and which version fixes it.
    const ids = [...new Set(vulnerable.flatMap((v) => v.ids))].slice(0, ADVISORY_CAP);
    const details = new Map<string, OsvVuln>();
    for (let i = 0; i < ids.length; i += 10)
      await Promise.all(
        ids.slice(i, i + 10).map(async (id) => {
          const d = await json<OsvVuln>(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {}, 8 * SECONDS);
          if (d) details.set(id, d);
        }),
      );
    for (const v of vulnerable) {
      v.advisories = v.ids
        .filter((id) => details.has(id))
        .map((id) => {
          const d = details.get(id)!;
          return { id, aliases: (d.aliases ?? []).slice(0, 6), summary: d.summary ?? null, severity: d.database_specific?.severity?.toUpperCase() ?? null, fixed: fixedFor(d, v.name, v.versions) };
        })
        .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
        // The same flaw is often published twice (a GitHub advisory and a PyPI or Go one): keep the first, rated one.
        .filter((a, i, all) => !all.slice(0, i).some((b) => b.id === a.id || b.aliases.includes(a.id) || a.aliases.includes(b.id) || b.aliases.some((x) => x.startsWith("CVE-") && a.aliases.includes(x))));
      const worst = v.advisories[0];
      v.severity = worst?.severity ?? null;
      v.summary = worst?.summary ?? null;
    }
    // "Unmaintained" notices (RustSec) say a crate has no maintainer, not that it has a flaw: kept out of the count.
    const UNMAINTAINED = /\bunmaintained\b|no longer (actively )?maintained|is not maintained|has been deprecated/i;
    for (const v of vulnerable) {
      const kept = (v.advisories ?? []).filter((a) => !UNMAINTAINED.test(a.summary ?? ""));
      if (v.advisories && kept.length < v.advisories.length && v.advisories.length === v.ids.length) {
        v.ids = v.ids.filter((id) => kept.some((a) => a.id === id) || !v.advisories!.some((a) => a.id === id));
        v.advisories = kept;
        v.severity = kept[0]?.severity ?? null;
        v.summary = kept[0]?.summary ?? null;
      }
    }
    vulnerable.splice(0, vulnerable.length, ...vulnerable.filter((v) => v.ids.length));
    vulnerable.sort((a, b) => sevRank(a.severity) - sevRank(b.severity));
  }
  return { total: pkgs.length, checked: checked.length, vulnerable, advisoriesShown: Math.min(ADVISORY_CAP, new Set(vulnerable.flatMap((v) => v.ids)).size) };
}

// The package names the repo's own manifests publish under, at any depth (monorepos publish many), as
// "REGISTRY:name": a crate named like the repo doesn't make a PyPI package of the same name its own. A package that
// only links back to the repo in its metadata, like a republished fork, isn't one of them.
const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, "-");
export function ownNames(files: Record<string, string>, fullName: string): Set<string> {
  const names = new Set<string>();
  for (const [path, text] of Object.entries(files)) {
    const file = path.split("/").pop()!;
    if (file === "package.json")
      try {
        const j = JSON.parse(text) as { name?: unknown; private?: unknown };
        if (typeof j.name === "string" && j.private !== true) names.add(`NPM:${norm(j.name)}`);
      } catch {}
    if (file === "pyproject.toml" || file === "Cargo.toml") {
      const m = /^\[(?:project|package|tool\.poetry)\][^[]*?^name\s*=\s*["']([^"']+)["']/ms.exec(text);
      if (m) names.add(`${file === "Cargo.toml" ? "CARGO" : "PYPI"}:${norm(m[1])}`);
    }
    if (file === "setup.py" || file === "setup.cfg") {
      const m = /\bname\s*[=:]\s*["']?([\w.-]+)/.exec(text);
      if (m) names.add(`PYPI:${norm(m[1])}`);
    }
    if (file === "go.mod") {
      const m = /^module\s+(\S+)/m.exec(text);
      if (m) names.add(`GO:${norm(m[1])}`);
    }
  }
  if (!Object.keys(files).length) names.add(`*:${norm(fullName.split("/")[1])}`); // no files read: only an exact name match
  return names;
}

// Stars over time from GitHub's star history endpoint: exact counts per week (newest first, 30 weeks a page), for
// any public repo. Since July 2026 GitHub lists who starred a repo only to its own admins, so this replaces sampling
// the stargazer list. Weeks are summed from the start, and the curve ends at today's count.
async function starHistory(fullName: string, total: number, createdAt: string): Promise<Facts["starHistory"]> {
  if (total < 20) return null;
  const weeks = Math.ceil((Date.now() - Date.parse(createdAt)) / (7 * 86_400_000)) + 1;
  const pages = Math.min(100, Math.ceil(weeks / 30));
  const rows: { week: number; total: number }[] = [];
  for (let i = 1; i <= pages; i += 6)
    await Promise.all(
      Array.from({ length: Math.min(6, pages - i + 1) }, (_, k) => i + k).map(async (page) => {
        const r = (await ghApi<{ week: number; total: number }[]>(`/repos/${fullName}/stargazers/history?per_page=30&page=${page}`)).data;
        if (Array.isArray(r)) rows.push(...r.filter((x) => typeof x.week === "number" && typeof x.total === "number"));
      }),
    );
  if (rows.length < 2) return null;
  rows.sort((a, b) => a.week - b.week);
  let sum = 0;
  const all = rows.map((r) => ({ t: r.week * 1000, stars: (sum += r.total) }));
  // Unstars make the weekly sums run a little above today's count: scaled so the curve ends at the real total.
  const scale = sum > 0 ? total / sum : 1;
  const step = Math.max(1, Math.ceil(all.length / 160)); // about 160 points is plenty for a chart
  const points = all.filter((_, i) => i % step === 0 || i === all.length - 1).map((p) => ({ date: new Date(p.t).toISOString(), stars: Math.round(p.stars * scale) }));
  points.push({ date: new Date().toISOString(), stars: total });
  // Every week from the first star, with the weeks GitHub leaves out (no stars) filled in as zero.
  const WEEK = 7 * 86_400;
  const first = rows[0].week;
  const gains = Array.from({ length: Math.round((rows[rows.length - 1].week - first) / WEEK) + 1 }, () => 0);
  for (const r of rows) gains[Math.round((r.week - first) / WEEK)] += r.total;
  return { points, capped: false, weekly: { start: new Date(first * 1000).toISOString(), gains } };
}

// Packages published from this repo, with downloads and dependents for the main ones. deps.dev links registries to
// repos from the packages' own metadata, which anyone can set, so only names the repo's manifests use are kept.
async function packages(fullName: string, ownP: Promise<Set<string>>): Promise<Facts["packages"]> {
  const j = await json<{ versions: { versionKey: { system: string; name: string; version: string } }[] }>(
    `https://api.deps.dev/v3/projects/${encodeURIComponent(`github.com/${fullName}`.toLowerCase())}:packageversions`,
  );
  if (!j) return null;
  const own = await ownP;
  const latest = new Map<string, { system: string; name: string; version: string }>();
  for (const v of j.versions ?? []) if (own.has(`${v.versionKey.system.toUpperCase()}:${norm(v.versionKey.name)}`) || own.has(`*:${norm(v.versionKey.name)}`)) latest.set(`${v.versionKey.system}:${v.versionKey.name}`, v.versionKey);
  const main = norm(fullName.split("/")[1]);
  const list = [...latest.values()].sort((a, b) => Number(norm(b.name).endsWith(main)) - Number(norm(a.name).endsWith(main))).slice(0, 3); // the one named after the repo first
  return Promise.all(
    list.map(async (p) => {
      const system = p.system.toUpperCase();
      let downloadsMonth: number | null = null;
      if (system === "NPM") downloadsMonth = (await json<{ downloads: number }>(`https://api.npmjs.org/downloads/point/last-month/${p.name}`))?.downloads ?? null;
      if (system === "PYPI") downloadsMonth = (await json<{ data: { last_month: number } }>(`https://pypistats.org/api/packages/${p.name.toLowerCase()}/recent`))?.data?.last_month ?? null;
      if (system === "CARGO") {
        const c = await json<{ crate: { recent_downloads: number } }>(`https://crates.io/api/v1/crates/${p.name}`);
        downloadsMonth = c ? Math.round(c.crate.recent_downloads / 3) : null; // crates.io reports 90 days
      }
      const dep = await json<{ dependentCount?: number }>(
        `https://api.deps.dev/v3alpha/systems/${p.system}/packages/${encodeURIComponent(p.name)}/versions/${encodeURIComponent(p.version)}:dependents`,
      );
      return { system, name: p.name, version: p.version, downloadsMonth, dependents: dep?.dependentCount ?? null };
    }),
  );
}

export async function collect(ref: RepoRef): Promise<Facts> {
  const full = `${ref.owner}/${ref.repo}`;
  const unavailable: Record<string, string> = {};
  const attempt = async <T,>(name: string, p: () => Promise<T | null>, ms = 15 * SECONDS): Promise<T | null> => {
    try {
      const r = await timeout(p(), ms);
      if (r === null) unavailable[name] = "no answer";
      return r;
    } catch (e) {
      unavailable[name] = e instanceof Error ? e.message : "failed";
      return null;
    }
  };

  // The repo itself first: everything else needs its real name and branch.
  const r = await ghApi<any>(`/repos/${full}`);
  if (!r.data) throw new Error(r.status === 404 ? "Repository not found (or it is private)." : "GitHub didn't answer. Try again in a minute.");
  const d = r.data;
  const repo: Facts["repo"] = {
    fullName: d.full_name,
    description: d.description,
    htmlUrl: d.html_url,
    homepage: d.homepage || null,
    defaultBranch: d.default_branch,
    createdAt: d.created_at,
    pushedAt: d.pushed_at,
    archived: Boolean(d.archived),
    fork: Boolean(d.fork),
    parent: d.parent?.full_name ?? null,
    stars: d.stargazers_count ?? 0,
    forks: d.forks_count ?? 0,
    watchers: d.subscribers_count ?? 0,
    openIssues: d.open_issues_count ?? 0,
    sizeKb: d.size ?? 0,
    topics: d.topics ?? [],
    licenseSpdx: d.license?.spdx_id ?? null,
    licenseName: d.license?.name ?? null,
    hasIssues: Boolean(d.has_issues),
    hasDiscussions: Boolean(d.has_discussions),
    isTemplate: Boolean(d.is_template),
  };
  const name = repo.fullName;
  const ownerLogin = name.split("/")[0];

  // GitHub computes commit statistics on demand and answers 202 until they're ready: asked once more after a pause.
  const stats = async <T,>(path: string): Promise<T | null> => {
    for (let i = 0; i < 2; i++) {
      const s = await ghApi<T>(path);
      if (s.data) return s.data;
      if (s.status !== 202) return null;
      await new Promise((res) => setTimeout(res, 2500));
    }
    return null;
  };

  // One commit for everything that reads files, so every link in the report points at what was inspected.
  const commit = await getHeadSha({ owner: ownerLogin, repo: name.split("/")[1] }, repo.defaultBranch).catch(() => null);
  const at = commit ?? repo.defaultBranch;
  const treeP = attempt("files", () => getTree({ owner: ownerLogin, repo: name.split("/")[1] }, at));
  const countP = ghCount(`/repos/${name}/contributors?anon=1`).catch(() => null);
  const starsP = attempt("star history", () => starHistory(name, repo.stars, repo.createdAt), 25 * SECONDS);
  const archiveP = commit ? attempt("whole repo", () => download(name, commit, repo.sizeKb), 35 * SECONDS) : Promise.resolve(null);
  if (!commit) unavailable["whole repo"] = "no commit";
  const ciP = attempt("ci", () => checks(name, commit, repo.defaultBranch));

  const [owner, languages, weeks, releases, contributors, community, gql, advisories, card, deps, pkgs, tree] = await Promise.all([
    attempt("owner", async () => {
      const o = await ghApi<any>(d.owner?.type === "Organization" ? `/orgs/${ownerLogin}` : `/users/${ownerLogin}`);
      if (!o.data) return null;
      return {
        login: ownerLogin,
        type: (d.owner?.type === "Organization" ? "Organization" : "User") as "User" | "Organization",
        createdAt: o.data.created_at ?? null,
        verified: typeof o.data.is_verified === "boolean" ? o.data.is_verified : null,
        name: o.data.name ?? null,
        company: o.data.company ?? null,
        followers: o.data.followers ?? null,
      };
    }),
    attempt("languages", async () => (await ghApi<Record<string, number>>(`/repos/${name}/languages`)).data),
    attempt("activity", async () => {
      const w = await stats<{ total: number }[]>(`/repos/${name}/stats/commit_activity`);
      return Array.isArray(w) ? w.map((x) => x.total) : null;
    }, 20 * SECONDS),
    attempt("releases", async () => {
      const rel = (await ghApi<any[]>(`/repos/${name}/releases?per_page=30`)).data;
      return rel
        ? rel
            .filter((x) => !x.draft)
            .map((x) => ({ tag: x.tag_name, date: x.published_at ?? x.created_at, prerelease: Boolean(x.prerelease), author: x.author?.login ?? null, assets: (x.assets ?? []).map((a: any) => a.name), sums: /\b(sha-?256|sha-?512|checksums?)\b/i.test(x.body ?? "") || (x.assets ?? []).some((a: any) => typeof a.digest === "string") }))
        : null;
    }),
    attempt("contributors", async () => {
      const list = await getContributors({ owner: ownerLogin, repo: name.split("/")[1] }, 100);
      return list.length ? list.map((c) => ({ login: c.login, commits: c.commits })) : null;
    }),
    attempt("community", async () => {
      const c = (await ghApi<{ health_percentage: number; files: Record<string, unknown> }>(`/repos/${name}/community/profile`)).data;
      return c ? { health: c.health_percentage, files: Object.fromEntries(Object.entries(c.files ?? {}).map(([k, v]) => [k, Boolean(v)])) } : null;
    }),
    // The GraphQL query waits for the file list, to know which file is the license.
    treeP.then((t) => {
      const license = t?.entries.find((e) => /^(LICEN[CS]E|COPYING)(\.(md|txt))?$/i.test(e.path))?.path ?? "";
      return attempt("discussions and contributors", () => ghGraphql<Gql>(GRAPHQL, { owner: ownerLogin, name: name.split("/")[1], license, withLicense: Boolean(license) }), 20 * SECONDS);
    }),
    attempt("security advisories", async () => {
      const a = (await ghApi<any[]>(`/repos/${name}/security-advisories?state=published&per_page=30`)).data;
      return a
        ? a.map((x) => ({ id: x.ghsa_id, cve: x.cve_id ?? null, severity: String(x.severity ?? "unknown"), summary: x.summary ?? "", published: x.published_at, url: x.html_url }))
        : null;
    }),
    attempt("security score", () => scorecard(name)),
    attempt("dependencies", () => dependencies(name), 45 * SECONDS),
    attempt("packages", () => packages(name, archiveP.then((a) => ownNames(a?.files ?? {}, name))), 40 * SECONDS),
    treeP,
  ]);
  const [archive, ci, contributorCount, stars] = await Promise.all([archiveP, ciP, countP, starsP]);
  if (repo.stars < 20) delete unavailable["star history"];

  // The files worth reading, from the list just fetched (raw.githubusercontent.com, not the API).
  const entries: TreeEntry[] = archive ? archive.paths.map((path) => ({ path, size: archive.files[path]?.length ?? 0 })) : (tree?.entries ?? []);
  // Most important first (license, README, rules, manifests), and only a few automation files, so a repo with
  // dozens of workflows still gets its license read.
  const rank = (p: string) => READ.findIndex((re) => re.test(p));
  const matching = entries.filter((e) => rank(e.path) >= 0).sort((a, b) => rank(a.path) - rank(b.path));
  const workflows = matching.filter((e) => e.path.startsWith(".github/workflows/")).slice(0, 8);
  const wanted = [...matching.filter((e) => !e.path.startsWith(".github/workflows/")), ...workflows].slice(0, MAX_READ);
  const texts: Record<string, string> = {};
  if (archive) {
    for (const e of wanted) if (archive.files[e.path] !== undefined) texts[e.path] = archive.files[e.path].slice(0, MAX_CHARS);
  } else
    try {
      const got = await timeout(getFiles({ owner: ownerLogin, repo: name.split("/")[1] }, at, wanted), 15 * SECONDS);
      for (const [path, text] of Object.entries(got)) texts[path] = text.slice(0, MAX_CHARS);
    } catch {
      unavailable["file contents"] = "took too long";
    }

  const g = gql?.repository ?? null;
  if (gql && !g) unavailable["discussions and contributors"] = "GitHub refused";
  unavailable["star check"] = "needs a different kind of GitHub access";
  return {
    collectedAt: Date.now(),
    repo,
    owner,
    languages,
    weeks,
    releases,
    contributors,
    contributorCount,
    starHistory: stars,
    community,
    paths: entries.map((e) => e.path),
    treeTruncated: archive ? false : Boolean(tree?.truncated),
    texts,
    threads: g
      ? {
          issues: g.issues.nodes.map((i) => thread(i, i.comments.nodes)),
          prs: g.pullRequests.nodes.map((p) => thread(p, [...p.comments.nodes, ...p.reviews.nodes])),
        }
      : null,
    // Who starred it, and when, shows bought stars, but GitHub only lists stargazers to classic tokens and GitHub Apps.
    stargazers: null,
    forksTop: g ? g.forks.nodes.map((f) => ({ name: f.nameWithOwner, stars: f.stargazerCount, pushedAt: f.pushedAt })) : null,
    recentCommits: g?.defaultBranchRef?.target.recent?.nodes.map((c) => ({ login: c.author?.user?.login ?? null, date: c.committedDate })) ?? null,
    licenseHistory: g?.defaultBranchRef?.target.license?.nodes.map((c) => ({ date: c.committedDate, message: c.messageHeadline })) ?? null,
    funding: g ? g.fundingLinks : null,
    advisories,
    scorecard: card,
    deps,
    packages: pkgs,
    unavailable,
    commit,
    ci,
    archive,
  };
}

// Checks that build or test the code, not the ones that label issues or greet contributors.
const BUILDS = /\b(tests?|testing|build|builds|lint|ci|e2e|unit|integration|compile|typecheck|types|check|checks|verify|go|node|python|rust|cargo|pytest|jest|vitest|clippy|macos|ubuntu|windows|linux)\b/i;
// Jobs that publish or tidy up rather than build or test: a failing release job isn't failing tests (Atuin).
const NOT_BUILDS = /\b(release|publish|deploy|docs?|pages|label(l?er)?|greet|stale|sync|claude|comment|triage|backport|changelog|codeql|scorecard|socket|dependabot|renovate|nightly|beta)\b/i;
const isBuild = (name: string) => BUILDS.test(name) && !NOT_BUILDS.test(name);

// CI results: the checks GitHub ran on this exact commit, or, when it has none (CI often runs only on pull
// requests), the latest finished run of each workflow on the default branch.
async function checks(fullName: string, commit: string | null, branch: string): Promise<Facts["ci"]> {
  if (commit) {
    // Every page: a busy repo has hundreds of runs per commit, the first pages often skipped bot jobs (MCP's SDK).
    type Run = { name: string; status: string; conclusion: string | null; html_url: string };
    const all: Run[] = [];
    for (let page = 1; page <= 6; page++) {
      const r = await ghApi<{ total_count: number; check_runs: Run[] }>(`/repos/${fullName}/commits/${commit}/check-runs?per_page=100&filter=latest&page=${page}`);
      all.push(...(r.data?.check_runs ?? []));
      if (!r.data || all.length >= r.data.total_count || r.data.check_runs.length < 100) break;
    }
    const runs = all.filter((c) => c.status === "completed" && c.conclusion !== "skipped" && c.conclusion !== "neutral" && isBuild(c.name));
    if (runs.some((c) => c.conclusion === "success" || c.conclusion === "failure"))
      return { source: "commit", runs: runs.map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.html_url })) };
  }
  const w = await ghApi<{ workflow_runs: { name: string; conclusion: string | null; html_url: string }[] }>(
    `/repos/${fullName}/actions/runs?branch=${encodeURIComponent(branch)}&status=completed&exclude_pull_requests=true&per_page=30`,
  );
  if (!w.data) return null;
  const latest = new Map<string, { name: string; conclusion: string | null; url: string }>();
  for (const run of w.data.workflow_runs) if (isBuild(run.name) && !latest.has(run.name)) latest.set(run.name, { name: run.name, conclusion: run.conclusion, url: run.html_url });
  return { source: "branch", runs: [...latest.values()] };
}

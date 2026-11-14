import type { Answer, Audience, EvidenceKind, Finding, GradeId, Inspection, Level, Priority, SectionId, Status } from "./types";

// The words the report uses, shared by the page (app/inspection.tsx) and the Markdown copy (markdown.ts), so both
// say the same thing.

// What each reader should see first. Everything is shown either way; only the order changes.
export const ORDER: Record<Audience, Answer["id"][]> = {
  personal: ["data", "cost", "trust", "alive", "responds", "vulns", "open", "control", "changes", "free", "popularity", "obligations"],
  business: ["obligations", "open", "free", "vulns", "changes", "control", "trust", "alive", "responds", "data", "cost", "popularity"],
};
export const GRADE_LABEL: Record<GradeId, string> = { maintenance: "Maintenance", continuity: "Continuity", community: "Support", security: "Security", openness: "License and privacy" };
export const LEVEL_LABEL: Record<Level, string> = { good: "Good", note: "Worth knowing", risk: "Look closer", neutral: "For context" };
export const STATUS_LABEL: Record<Status, string> = { pass: "Pass", concern: "Concern", info: "Info", "not-found": "Not found", "not-checked": "Not checked", "n/a": "Not applicable" };
export const KIND_LABEL: Record<EvidenceKind, string> = { documented: "Documented", detected: "Detected in the files", reported: "Reported by GitHub or a service", inferred: "Inferred by Claude, quotes checked" };
export const PRIORITY_LABEL: Record<Priority, string> = { blocker: "Setup blocker", important: "Important", improvement: "Improvement" };
export const SECTION_LABEL: Record<SectionId, string> = {
  setup: "Setup steps", config: "Settings", services: "Services and accounts", requirements: "Requirements", tests: "Tests and CI", deploy: "Deployment", secrets: "Secrets",
  license: "License", control: "Control", activity: "Activity", releases: "Releases", people: "People", responsiveness: "Responsiveness", community: "Community",
  security: "Security", dependencies: "Dependencies", supply: "Downloads and builds", privacy: "Privacy", popularity: "Popularity", cost: "Costs",
};
// "Before you run it": what you'll need to get it working, in this order.
export const SETUP: SectionId[] = ["setup", "config", "services", "requirements", "secrets", "tests", "deploy"];
const RANK_PRIORITY: Record<Priority, number> = { blocker: 0, important: 1, improvement: 2 };
export const rankOf = (x: Finding) => (x.priority ? RANK_PRIORITY[x.priority] : x.status === "concern" ? 2.5 : x.status === "pass" ? 4 : x.status === "n/a" ? 6 : 5);

// The setup findings shown under "Before you run it", most serious first.
export const setupFindings = (report: Inspection) =>
  report.findings.filter((x) => SETUP.includes(x.section) && x.id !== "setup.kind" && x.status !== "n/a").sort((a, b) => rankOf(a) - rankOf(b));

// What was actually run: nothing by gitmanual; build and test results are the repo's own CI, reported by GitHub.
export function verified(report: Inspection): string {
  const ci = report.findings.find((x) => x.id === "tests.result");
  const own = "gitmanual read the files; it didn't install, build or run anything.";
  if (!ci || ci.status === "not-found") return `${own} No CI results were available either, so nothing here was confirmed by running it.`;
  return `${own} Build and test results are the repo's own CI on GitHub (${/^[A-Z][a-z]/.test(ci.title) ? ci.title.charAt(0).toLowerCase() + ci.title.slice(1) : ci.title}), not checks gitmanual ran.`;
}

const n = (x: number) => x.toLocaleString("en-US");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// Shown near the top when the inspection couldn't read the whole repo.
export function limited(report: Inspection): string | null {
  const s = report.scope;
  if (!s || s.archive) return null;
  return `Limited inspection: ${n(s.filesRead)} of ${n(s.filesInRepo)} files read (the repo was too large to download), and nothing was run. Checks that need the rest of the files are marked as not checked or worded as unconfirmed.`;
}

// How far each kind of evidence reaches, one line each.
export function coverageLines(report: Inspection): { label: string; text: string }[] {
  const s = report.scope;
  if (!s) return [{ label: "Execution", text: verified(report) }];
  const c = s.coverage;
  const out = [
    { label: "File list", text: `${n(s.filesInRepo)} paths${c && !c.listComplete ? " (GitHub cut the list short, so some are missing)" : ", the complete list"}.` },
    {
      label: "File contents",
      text: s.archive ? `${n(s.filesRead)} files read: the whole repo, apart from what's listed under "Not read".` : `${n(s.filesRead)} files read: only the main ones (README, license, root manifests, settings examples).`,
    },
  ];
  if (c) {
    out.push({ label: "Manifests", text: `${n(c.manifests.read)} of ${n(c.manifests.found)} package manifests read.` });
    if (c.deps)
      out.push({
        label: "Dependencies",
        text: `${n(c.deps.checked)} of ${n(c.deps.total)} listed by GitHub checked against OSV.dev${c.deps.checked >= c.deps.cap ? `: at most ${n(c.deps.cap)} are checked, so this is partial` : c.deps.total > c.deps.checked ? "; the rest are listed without an exact version to check" : ""}.`,
      });
    const hist = [
      c.commits && `the latest ${n(c.commits.count)} commits${c.commits.since ? ` (since ${day(c.commits.since)})` : ""}`,
      c.issues && `the latest ${n(c.issues.count)} issues${c.issues.since ? ` (since ${day(c.issues.since)})` : ""}`,
      c.releases !== null && `${n(c.releases)} recent releases`,
    ].filter(Boolean);
    if (hist.length) out.push({ label: "History", text: `Branch ${s.branch}: ${hist.join(", ")}. Contributor totals are all-time.` });
  }
  out.push({ label: "Execution", text: verified(report) });
  return out;
}

export const ARCH_NOTE = "Inferred by Claude: the paths exist, and how the parts connect is its reading of the files.";

// The flawed dependencies as table rows, one per advisory, worst first. Older reports have only the first advisory
// of each package, with no fixed version.
export type VulnRow = { pkg: string; ecosystem: string; versions: string; id: string; alias: string | null; url: string; summary: string | null; severity: string; scope: string; fixed: string; first: boolean; span: number };
const SCOPE_LABEL = { direct: "Direct", dev: "Development", indirect: "Indirect" } as const;
export function vulnRows(report: Inspection): VulnRow[] {
  const d = report.facts.deps;
  if (!d) return [];
  return d.vulnerable.flatMap((v) => {
    const advs = v.advisories?.length ? v.advisories : [{ id: v.ids[0], aliases: [], summary: v.summary, severity: v.severity, fixed: null }];
    return advs.map((a, i) => ({
      pkg: v.name,
      ecosystem: v.ecosystem,
      versions: v.versions.join(", "),
      id: a.id,
      alias: a.aliases.find((x) => x.startsWith("CVE-")) ?? null,
      url: `https://osv.dev/vulnerability/${encodeURIComponent(a.id)}`,
      summary: a.summary,
      severity: (a.severity ?? "unknown").toLowerCase(),
      scope: v.scope ? SCOPE_LABEL[v.scope] : "Unknown",
      fixed: a.fixed ?? "Unknown",
      first: i === 0,
      span: advs.length,
    }));
  });
}
export function vulnNote(report: Inspection): string {
  const d = report.facts.deps!;
  const ids = new Set(d.vulnerable.flatMap((v) => v.ids)).size;
  const rows = vulnRows(report).length;
  const capped = d.advisoriesShown !== undefined && d.advisoriesShown < ids;
  return [
    `${d.vulnerable.length} of ${d.checked.toLocaleString("en-US")} checked packages have known advisories in OSV.dev${d.checked >= 1000 ? " (at most 1,000 packages are checked, so this is partial)" : ""}: ${rows} shown${capped ? `, from the first ${d.advisoriesShown} of ${ids} looked up` : d.advisoriesShown === undefined ? ", the first for each package" : ""}, with the same flaw published twice counted once.`,
    "Scope: direct means listed in its own manifests, development means a dev tool (it runs in builds and CI), indirect means pulled in by another package; which package pulls it in isn't shown by GitHub's dependency list.",
    "Fixed in: the first version above the one installed that the advisory says fixes it.",
  ].join(" ");
}

// ── Triage: how bad, and what first ──────────────────────────────────────────────────────────────────────────────
// Each check falls into one bucket, most serious first. Priority (blocker, important, improvement) is how much it
// matters to someone about to use the repo; level (risk, note) is how strong the signal is. The page leads with
// priority, so the worst problems come first and passes stay out of the way.
export type Bucket = "blocker" | "important" | "improvement" | "pass" | "unchecked" | "info";
export const BUCKETS: { id: Bucket; label: string; short: string }[] = [
  { id: "blocker", label: "Setup blockers", short: "Blockers" },
  { id: "important", label: "Important", short: "Important" },
  { id: "improvement", label: "Improvements", short: "Improvements" },
  { id: "pass", label: "Passed", short: "Passed" },
  { id: "unchecked", label: "Not checked", short: "Not checked" },
  { id: "info", label: "For context", short: "Context" },
];
export function bucketOf(x: Finding): Bucket {
  if (x.priority === "blocker") return "blocker";
  if (x.priority === "important") return "important";
  if (x.priority === "improvement" || x.status === "concern") return "improvement";
  if (x.status === "pass") return "pass";
  if (x.status === "not-checked") return "unchecked";
  return "info";
}
// The checks that count: not the project-kind note or checks that don't apply.
export const counted = (report: Inspection) => report.findings.filter((x) => x.id !== "setup.kind" && x.status !== "n/a");
export function triage(report: Inspection): Record<Bucket, number> {
  const out = { blocker: 0, important: 0, improvement: 0, pass: 0, unchecked: 0, info: 0 } as Record<Bucket, number>;
  for (const x of counted(report)) out[bucketOf(x)]++;
  return out;
}
// The overall call, from gitmanual's own checks only (not Claude's wording), and worded to what was looked at.
export function verdict(report: Inspection): { tone: "no" | "maybe" | "yes"; title: string; text: string } {
  const t = triage(report);
  const part = report.scope && !report.scope.archive ? " in the files read" : "";
  if (t.blocker)
    return { tone: "no", title: "Fix before running", text: `${t.blocker} setup blocker${t.blocker === 1 ? "" : "s"} found${part}: steps that would stop it from running as documented.` };
  if (t.important)
    return { tone: "maybe", title: "Check before relying on it", text: `No setup blockers found${part}, but ${t.important} important concern${t.important === 1 ? "" : "s"} to look at first.` };
  return { tone: "yes", title: "No major concerns found", text: `No setup blockers or important concerns found${part}${t.improvement ? `; ${t.improvement} smaller improvement${t.improvement === 1 ? "" : "s"} listed below` : ""}.` };
}
// What to look at first: blockers, then important concerns, worst signal first. Improvements only when nothing
// bigger was found, so the list never cries wolf.
// The order of "look at these first": whether the project is still here, then what stops it running, then what
// could hurt you (security, your data), then legal terms, then other setup work, and continuity last.
const RISK_CLASS: [RegExp, number][] = [
  [/^activity\.(moved|archived|notice)$/, 0],
  [/^(security|secrets|supply|dependencies)$/, 2],
  [/^privacy$/, 3],
  [/^license$/, 4],
  [/^(setup|config|services|requirements|tests|deploy|cost)$/, 5],
];
export function riskClass(x: Finding): number {
  if (/^activity\.(moved|archived|notice)$/.test(x.id)) return 0;
  if (bucketOf(x) === "blocker") return 1;
  return RISK_CLASS.find(([re]) => re.test(x.section))?.[1] ?? 6;
}
export function fixFirst(report: Inspection, max = 5): Finding[] {
  const order: Bucket[] = ["blocker", "important"];
  const levelRank = { risk: 0, note: 1, good: 3, neutral: 2 } as const;
  const top = counted(report)
    .filter((x) => order.includes(bucketOf(x)))
    .sort((a, b) => riskClass(a) - riskClass(b) || order.indexOf(bucketOf(a)) - order.indexOf(bucketOf(b)) || levelRank[a.level] - levelRank[b.level]);
  if (top.length) return top.slice(0, max);
  return counted(report).filter((x) => bucketOf(x) === "improvement").sort((a, b) => riskClass(a) - riskClass(b) || levelRank[a.level] - levelRank[b.level]).slice(0, 3);
}

// One row per package: the worst severity, how many advisories, and the version that fixes all the known ones.
const cmpVersion = (a: string, b: string) => {
  const [x, y] = [a.replace(/^v/, "").split(/[.+-]/), b.replace(/^v/, "").split(/[.+-]/)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [m, n] = [Number(x[i] ?? 0), Number(y[i] ?? 0)];
    if (!Number.isNaN(m) && !Number.isNaN(n) && m !== n) return m - n;
  }
  return 0;
};
const SEV_ORDER = ["critical", "high", "moderate", "medium", "low", "unknown"];
export type VulnPackage = { pkg: string; ecosystem: string; versions: string; worst: string; count: number; scope: string; fixAll: string; advisories: VulnRow[] };
export function vulnPackages(report: Inspection): VulnPackage[] {
  const rows = vulnRows(report);
  const out: VulnPackage[] = [];
  for (const r of rows) {
    if (r.first) out.push({ pkg: r.pkg, ecosystem: r.ecosystem, versions: r.versions, worst: r.severity, count: 0, scope: r.scope, fixAll: "Unknown", advisories: [] });
    const p = out[out.length - 1];
    p.advisories.push(r);
    p.count++;
    if (SEV_ORDER.indexOf(r.severity) < SEV_ORDER.indexOf(p.worst)) p.worst = r.severity;
  }
  for (const p of out) {
    const fixes = p.advisories.map((a) => a.fixed).filter((x) => x !== "Unknown");
    // Every advisory names a fix: the highest one clears them all. Otherwise say how many are covered.
    if (fixes.length) {
      const top = fixes.sort(cmpVersion).at(-1)!;
      p.fixAll = fixes.length === p.advisories.length ? top : `${top} (fixes ${fixes.length} of ${p.advisories.length})`;
    }
  }
  return out;
}

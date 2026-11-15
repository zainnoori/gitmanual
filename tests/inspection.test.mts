import assert from "node:assert/strict";
import { test } from "node:test";
import type { Facts } from "../lib/inspection/collect";
import type { Finding } from "../lib/inspection/types";
import { findings, finish, grades, headline, licenseKind } from "../lib/inspection/rules";
import { aiReview } from "../lib/inspection/ai";
import { ownNames } from "../lib/inspection/collect";

// Deep Inspection's rules, on small made-up repos: what each kind of license means, the signals people need, and
// that the AI step can only add what the repo's own files say.

const NOW = Date.parse("2026-11-14T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 864e5).toISOString();

function facts(over: Partial<Facts> = {}, repo: Partial<Facts["repo"]> = {}): Facts {
  return {
    collectedAt: NOW,
    repo: {
      fullName: "acme/tool",
      description: "A tool",
      htmlUrl: "https://github.com/acme/tool",
      homepage: null,
      defaultBranch: "main",
      createdAt: daysAgo(4 * 365),
      pushedAt: daysAgo(3),
      archived: false,
      fork: false,
      parent: null,
      stars: 2000,
      forks: 100,
      watchers: 30,
      openIssues: 10,
      sizeKb: 1000,
      topics: [],
      licenseSpdx: "MIT",
      licenseName: "MIT License",
      hasIssues: true,
      hasDiscussions: false,
      ...repo,
    },
    owner: { login: "acme", type: "Organization", createdAt: daysAgo(6 * 365), verified: true, name: "Acme", company: null, followers: 10 },
    languages: { TypeScript: 1000 },
    weeks: Array(52).fill(5),
    releases: [],
    contributors: [
      { login: "ana", commits: 400 },
      { login: "ben", commits: 300 },
      { login: "cy", commits: 200 },
    ],
    community: { health: 80, files: { contributing: true, code_of_conduct: true } },
    paths: ["README.md", "LICENSE", "SECURITY.md", "package.json"],
    treeTruncated: false,
    texts: { "README.md": "# Tool\nRun `npm install`.", LICENSE: "MIT License\n\nPermission is hereby granted, free of charge, to any person" },
    threads: null,
    stargazers: null,
    forksTop: null,
    recentCommits: null,
    licenseHistory: [],
    funding: null,
    advisories: [],
    scorecard: null,
    deps: { total: 10, checked: 10, vulnerable: [] },
    packages: null,
    unavailable: {},
    ...over,
  };
}
const find = (f: Facts, id: string) => findings(f, {}, NOW).find((x) => x.id === id);

test("licenses read the way they work: permissive, AGPL, source-available, none, several", () => {
  assert.equal(licenseKind(facts()).kind, "permissive");
  assert.equal(licenseKind(facts({}, { licenseSpdx: "AGPL-3.0" })).kind, "network-copyleft");
  assert.equal(licenseKind(facts({}, { licenseSpdx: "BUSL-1.1" })).kind, "source-available");
  const none = facts({ texts: { "README.md": "# Tool" } }, { licenseSpdx: null, licenseName: null });
  assert.equal(licenseKind(none).kind, "none");
  assert.equal(find(none, "license.none")!.level, "risk");
  // GitHub couldn't name it; the files say what it is. The GPL's own "noncommercially" doesn't make it non-commercial.
  const gpl = "GNU GENERAL PUBLIC LICENSE\nVersion 3\n" + "x ".repeat(2000) + "allowed only occasionally and noncommercially";
  const mixed = facts({ texts: { "COPYING.GPLv3": gpl, "COPYING.0BSD": "Permission to use, copy, modify, and/or\ndistribute this software for any purpose" } }, { licenseSpdx: "NOASSERTION" });
  assert.deepEqual(licenseKind(mixed), { kind: "mixed", name: "GPL, 0BSD" });
  const sul = facts({ texts: { "LICENSE.md": "# Sustainable Use License\nVersion 1.0" } }, { licenseSpdx: "NOASSERTION" });
  assert.equal(licenseKind(sul).kind, "source-available");
});

test("a relicensing is caught; edits to the license file's wording aren't", () => {
  const f = facts({
    licenseHistory: [
      { date: daysAgo(30), message: "Update LICENSE punctuation and wording" },
      { date: daysAgo(800), message: "Updating the license from MPL to Business Source License" },
    ],
  }, { licenseSpdx: "BUSL-1.1" });
  const x = find(f, "license.changed")!;
  assert.equal(x.level, "risk");
  assert.match(x.text, /Business Source License/);
  assert.doesNotMatch(x.text, /punctuation/);
  assert.equal(find(facts({ licenseHistory: [{ date: daysAgo(30), message: "update year in license files" }] }), "license.changed"), undefined);
});

test("who controls it: one person doing the work, a CLA, open core", () => {
  const solo = facts({ contributors: [{ login: "ana", commits: 900 }, { login: "ben", commits: 20 }] });
  // In an organization's project, concentration is context (an improvement), not a reason to look first.
  assert.equal(find(solo, "control.absence")!.level, "note");
  // One person on a personal account writing nearly everything, still today: the strong signal.
  const personal = facts({ contributors: [{ login: "ana", commits: 900 }, { login: "ben", commits: 20 }], owner: { login: "ana", type: "User", createdAt: daysAgo(3000), verified: false, name: null, company: null, followers: 1 } as never });
  assert.equal(find(personal, "control.absence")!.level, "risk");
  assert.equal(find(personal, "control.absence")!.title, "One person does nearly all the work");
  assert.match(find(solo, "control.absence")!.text, /@ana wrote 98%/);
  assert.equal(find(facts(), "control.absence")!.title, "2 people wrote half the commits");
  const cla = facts({ paths: ["README.md", "LICENSE", "CLA.md"] });
  assert.equal(find(cla, "license.cla")!.level, "note");
  const core = facts({ paths: ["README.md", "LICENSE", "ee/LICENSE", "ee/server/billing.ts"] });
  assert.match(find(core, "license.opencore")!.text, /the ee folder/);
});

test("a new main contributor in an old repo is pointed out, plainly", () => {
  const recent = [...Array(60).fill({ login: "newbie", date: daysAgo(20) }), ...Array(40).fill({ login: "ana", date: daysAgo(90) })];
  const f = facts({ recentCommits: recent, contributors: [{ login: "ana", commits: 900 }, { login: "newbie", commits: 62 }] });
  const x = find(f, "control.newcomer")!;
  assert.equal(x.level, "note");
  assert.match(x.text, /@newbie wrote 60 of the last 100 commits/);
  assert.match(x.text, /xz/);
});

test("alive, answering, safe to download, sending data: the signals that matter", () => {
  assert.equal(find(facts({}, { archived: true }), "activity.archived")!.level, "risk");
  assert.equal(find(facts({}, { pushedAt: daysAgo(500) }), "activity.last")!.level, "risk");
  const quiet = facts({
    threads: {
      issues: Array.from({ length: 10 }, (_, i) => ({ createdAt: daysAgo(30 + i), closedAt: null, bot: false, firstReply: null })),
      prs: [],
    },
  });
  assert.equal(find(quiet, "responsiveness.issues")!.level, "risk");
  const pipe = facts({ texts: { "README.md": "Install:\n\ncurl -fsSL https://acme.dev/install.sh | sh" } });
  assert.ok(find(pipe, "supply.pipe"));
  const tele = facts({ texts: { "README.md": "We collect anonymous usage data. Set DO_NOT_TRACK=1 to opt out.", "package.json": '{"dependencies":{"posthog-node":"4"}}' } });
  assert.equal(find(tele, "privacy.telemetry")!.title, "Telemetry, on by default");
  assert.match(find(tele, "privacy.sdks")!.text, /PostHog/);
  assert.equal(find(facts(), "privacy.none")!.level, "neutral");
});

test("the headline always answers 'recent changes' and grades follow the findings", () => {
  const all = findings(facts(), {}, NOW);
  const h = headline(all);
  assert.equal(h.find((a) => a.id === "changes")!.verdict, "Nothing unusual seen");
  assert.equal(h.find((a) => a.id === "changes")!.level, "neutral"); // nothing seen isn't a pass
  assert.equal(h.find((a) => a.id === "open")!.level, "good");
  const g = grades(all);
  assert.equal(g.parts.openness!.grade, "A");
  const bad = grades(findings(facts({ texts: {} }, { archived: true, licenseSpdx: null, licenseName: null }), {}, NOW));
  assert.equal(bad.parts.maintenance!.grade, "F");
  assert.notEqual(bad.overall, "A");
});

test("the AI step keeps a finding only when its quotes are really in the repo's files, and paths only if they exist", async () => {
  const f = facts({ texts: { "LICENSE.md": "You may distribute the software only if you do so free of charge for non-commercial purposes.", "README.md": "Requires Node 18.\nRun npm start" } }, {});
  const fake = {
    messages: {
      parse: async () => ({
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 200 },
        parsed_output: {
          does: "A tool.",
          needs: ["Node.js 20"],
          blockers: [],
          first: ["Read the license."],
          business: "Check the license.",
          architecture: { summary: "One server.", parts: [{ name: "Server", role: "Serves it", paths: ["src/server.ts", "made/up.ts"] }, { name: "Readme", role: "Docs", paths: ["README.md"] }, { name: "Ghost", role: "x", paths: ["nope/"] }], links: [{ from: "Server", to: "Readme", label: "serves" }, { from: "Server", to: "Ghost", label: "x" }] },
          findings: [
            { headline: "obligations", level: "risk", priority: "important", title: "Free distribution only", text: "Only free sharing.", action: "Ask for a license.", quotes: [{ file: "LICENSE.md", text: "only if you do so free of charge" }] },
            { headline: "data", level: "risk", priority: "important", title: "Sends your files", text: "Made up.", action: "x", quotes: [{ file: "README.md", text: "uploads every file you open to our servers" }] },
            { headline: "setup", level: "note", priority: "blocker", title: "Half proven", text: "One quote is real.", action: "x", quotes: [{ file: "README.md", text: "Requires Node 18." }, { file: "README.md", text: "this sentence is not in the readme" }] },
          ],
        },
      }),
    },
  };
  const r = await aiReview(f, [], { client: fake as never, paths: ["src/server.ts", "README.md"] });
  assert.ok(!("failed" in r));
  if ("failed" in r) return;
  assert.equal(r.decision.business, "Check the license.");
  assert.deepEqual(r.findings.map((x) => [x.id, x.kind, x.evidence![0].label]), [["ai.obligations.0", "inferred", "LICENSE.md:1"]]);
  assert.match(r!.findings[0].action!, /^Suggestion: /);
  assert.deepEqual(r!.architecture!.parts, [{ name: "Server", role: "Serves it", paths: ["src/server.ts"] }, { name: "Readme", role: "Docs", paths: ["README.md"] }]);
  assert.deepEqual(r!.architecture!.links, [{ from: "Server", to: "Readme", label: "serves" }]); // a link to a dropped part goes too
});

test("who answers: maintainers, other users and bots are told apart, with the sample's dates", () => {
  const issue = (i: number, reply: "maintainer" | "user" | "bot" | null) => ({
    createdAt: daysAgo(10 + i),
    closedAt: null,
    bot: false,
    firstReply: reply === "maintainer" || reply === "user" ? { at: daysAgo(9 + i), maintainer: reply === "maintainer" } : null,
    maintainerReply: reply === "maintainer" ? daysAgo(9 + i) : null,
    botReply: reply === "bot",
  });
  const f = facts({ threads: { issues: [...[0, 1, 2, 3].map((i) => issue(i, "maintainer")), ...[4, 5].map((i) => issue(i, "user")), issue(6, "bot"), issue(7, null)], prs: [] } });
  const t = find(f, "responsiveness.issues")!.text;
  assert.match(t, /opened since /);
  assert.match(t, /4 from a maintainer/);
  assert.match(t, /2 only from other users/);
  assert.match(t, /1 only from bots, not counted/);
  assert.match(t, /2 of 8 older than a week \(25%\)/);
});

test("only packages the repo's own manifests name count as its packages", () => {
  const own = ownNames(
    {
      "package.json": '{"name":"superpowers","version":"1.0.0"}',
      "packages/core/package.json": '{"name":"@acme/core"}',
      "packages/site/package.json": '{"name":"site","private":true}',
      "py/pyproject.toml": '[project]\nname = "acme_tool"\nversion = "1"',
      "go.mod": "module github.com/acme/tool\n\ngo 1.22",
    },
    "acme/superpowers",
  );
  for (const n of ["NPM:superpowers", "NPM:@acme/core", "PYPI:acme-tool", "GO:github-com/acme/tool"]) assert.ok(own.has(n), n);
  assert.ok(!own.has("NPM:site")); // private, never published
  assert.ok(!own.has("NPM:hwzx-superpowers")); // a republish that only links back to the repo
  assert.ok(!own.has("PYPI:superpowers")); // same name, different registry
  assert.deepEqual([...ownNames({}, "acme/superpowers")], ["*:superpowers"]); // nothing read: exact name only
});

test("grades keep continuity, support and security practices apart", () => {
  const g = grades(findings(facts(), {}, NOW));
  for (const k of Object.keys(g.parts)) assert.ok(["community", "continuity", "maintenance", "openness", "security"].includes(k), k);
  assert.ok(g.parts.maintenance);
  assert.equal(find(facts(), "community.security")!.section, "security");
});

test("the Markdown copy has every section and every check, with ids for feedback", async () => {
  const { toMarkdown } = await import("../lib/inspection/markdown");
  const f = facts({ texts: { "README.md": "We collect anonymous usage data.\n| a | b |" } });
  const all = findings(f, {}, NOW);
  const report = { version: 2, repo: "acme/tool", scannedAt: NOW, facts: f, findings: all, headline: headline(all), summary: null, grades: grades(all), unavailable: ["star check"] };
  const md = toMarkdown(report as never, "business");
  for (const h of ["# Deep Inspection: acme/tool", "## Grades", "## Key findings", "## Every other check", "## What was inspected", "### Couldn't check this time"]) assert.ok(md.includes(h), h);
  for (const x of all.filter((x) => x.id !== "setup.kind")) assert.ok(md.includes(`\`${x.id}\``), x.id);
  assert.match(md, /didn't install, build or run anything/);
  assert.ok(!/\n{3,}/.test(md));
});

test("claims stay within the evidence: lock files, release recency, open core, support, advice", () => {
  // Ranges with a lock file weren't checked; they don't change from day to day.
  const ranged = facts({ paths: ["README.md", "LICENSE", "yarn.lock"], deps: { total: 500, checked: 100, vulnerable: [{ name: "lodash", version: "4.17.0", ids: ["GHSA-1"], severity: "HIGH" }] } as never });
  assert.equal(find(ranged, "deps.unpinned")!.title, "Some versions not checked");
  assert.match(find(ranged, "deps.unpinned")!.text, /Installs from yarn\.lock get the versions it fixes/);
  assert.match(find(ranged, "deps.vulns")!.action!, /yarn npm audit/);
  assert.match(find(ranged, "deps.vulns")!.text, /1 of those packages have one rated high or critical/);
  // A busy release history doesn't make a 9-month-old release "regular".
  const rels = Array.from({ length: 10 }, (_, i) => ({ tag: `v1.${10 - i}`, date: daysAgo(270 + i * 2), prerelease: false, author: "acme", assets: [] }));
  const old = find(facts({ releases: rels as never }), "releases.cadence")!;
  assert.equal(old.level, "note");
  assert.match(old.title, /^No release in 9 months/);
  assert.match(old.text, /last 10 releases, from .* to .*, came a median of/);
  // An "enterprise" folder alone is a question about the license's scope; a license file in it is open core.
  const named = facts({ paths: ["README.md", "LICENSE", "apps/web/enterprise/page.tsx"] });
  assert.equal(find(named, "license.opencore"), undefined);
  assert.equal(find(named, "license.scope")!.status, "info");
  // Community files alone don't grade support.
  const files = grades(findings(facts({ threads: null }), {}, NOW));
  assert.equal(files.parts.community, undefined);
  // Install-script advice warns about what --ignore-scripts can skip.
  const hooks = find(facts({ texts: { "package.json": '{"scripts":{"postinstall":"node setup.js"}}' } }), "supply.hooks");
  assert.match(finish(hooks!).action!, /may also skip build or setup steps/);
  // Telemetry advice quotes the setting only when the docs name one.
  const tele = (readme: string) => finish(find(facts({ texts: { "README.md": readme } }), "privacy.telemetry")!).action!;
  assert.match(tele("We collect anonymous usage data. Set DO_NOT_TRACK=1 to opt out."), /DO_NOT_TRACK=1/);
  assert.match(tele("We collect anonymous usage data."), /wasn't found in the files read/);
});

test("vulnerabilities: versions compare by number, the fix is the first one above what's installed", async () => {
  const { compareVersions, fixedFor } = await import("../lib/inspection/collect");
  assert.ok(compareVersions("1.10.0", "1.9.2") > 0);
  assert.ok(compareVersions("2.0.0-beta.1", "2.0.0") < 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  const adv = { affected: [
    { package: { name: "lodash" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] },
    { package: { name: "lodash" }, ranges: [{ events: [{ fixed: "3.10.2" }] }] },
    { package: { name: "other" }, ranges: [{ events: [{ fixed: "9.0.0" }] }] },
  ] } as never;
  assert.equal(fixedFor(adv, "lodash", ["4.17.15", "3.10.1"]), "4.17.21");
  assert.equal(fixedFor(adv, "lodash", ["5.0.0"]), null);
  const { vulnRows } = await import("../lib/inspection/labels");
  const f = facts({ deps: { total: 10, checked: 10, vulnerable: [
    { name: "lodash", versions: ["4.17.15"], ecosystem: "npm", ids: ["GHSA-a", "GHSA-b"], severity: "HIGH", summary: "x", scope: "direct",
      advisories: [{ id: "GHSA-a", aliases: ["CVE-2021-1"], summary: "Prototype pollution", severity: "HIGH", fixed: "4.17.21" }, { id: "GHSA-b", aliases: [], summary: null, severity: null, fixed: null }] },
    { name: "old", versions: ["1.0.0"], ecosystem: "npm", ids: ["GHSA-c"], severity: "LOW", summary: "y" },
  ] } as never });
  const rows = vulnRows({ facts: f } as never);
  assert.deepEqual(rows.map((r) => [r.pkg, r.alias ?? r.id, r.severity, r.scope, r.fixed, r.first]), [
    ["lodash", "CVE-2021-1", "high", "Direct", "4.17.21", true],
    ["lodash", "GHSA-b", "unknown", "Direct", "Unknown", false],
    ["old", "GHSA-c", "low", "Unknown", "Unknown", true], // an older report: first advisory only, scope and fix unknown
  ]);
});

test("the same place cited twice becomes one link", () => {
  const x = finish({ id: "config.env", section: "config", level: "note", title: "t", text: "t", evidence: [{ label: "a.ts:3", url: "u#L3" }, { label: "a.ts:3", url: "u#L3" }, { label: "b.ts", url: "v" }] });
  assert.deepEqual(x.evidence!.map((e) => e.label), ["a.ts:3", "b.ts"]);
});

test("triage: every check in one bucket, the call from blockers and important concerns, worst first", async () => {
  const { bucketOf, fixFirst, triage, verdict } = await import("../lib/inspection/labels");
  const mk = (id: string, priority: Finding["priority"], level: Finding["level"], status: Finding["status"]) => ({ id, section: "setup", level, priority, status, title: id, text: id }) as Finding;
  const findingsList = [
    mk("a", "important", "note", "concern"),
    mk("b", "blocker", "risk", "concern"),
    mk("c", "improvement", "note", "concern"),
    mk("d", undefined, "good", "pass"),
    mk("e", undefined, "neutral", "not-checked"),
    mk("setup.kind", undefined, "neutral", "info"),
    mk("f", undefined, "neutral", "n/a"),
  ];
  const report = { findings: findingsList, scope: { archive: true } } as never;
  assert.deepEqual(findingsList.slice(0, 5).map(bucketOf), ["important", "blocker", "improvement", "pass", "unchecked"]);
  assert.deepEqual(triage(report), { blocker: 1, important: 1, improvement: 1, pass: 1, unchecked: 1, info: 0 });
  assert.equal(verdict(report).title, "Fix before running");
  assert.deepEqual(fixFirst(report).map((x) => x.id), ["b", "a"]); // improvements wait while anything bigger exists
  const calm = { findings: [findingsList[2], findingsList[3]], scope: { archive: false } } as never;
  assert.equal(verdict(calm).title, "No major concerns found");
  assert.match(verdict(calm).text, /in the files read/); // a partial read says so
  assert.deepEqual(fixFirst(calm).map((x) => x.id), ["c"]);
});

test("an unusable Claude answer still reports what it used, so it's paid for and released", async () => {
  const fake = { messages: { parse: async () => ({ stop_reason: "max_tokens", usage: { input_tokens: 9000, output_tokens: 6000 }, parsed_output: null }) } };
  const r = await aiReview(facts(), [], { client: fake as never });
  assert.deepEqual(r, { failed: "max_tokens", usage: { input_tokens: 9000, output_tokens: 6000 } });
});

test("Claude can't raise a blocker, intended-use notes stay improvements, and quoted disputes downgrade a rule", async () => {
  const f = facts({ texts: { "README.md": "Migrations run automatically when the server starts.\nOnly for personal use, not production." } }, {});
  const rule: Finding = { id: "setup.migrations", section: "setup", level: "risk", status: "concern", priority: "blocker", title: "No step creates the database tables", text: "x" };
  const fake = { messages: { parse: async () => ({ stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, parsed_output: {
    does: "x", needs: [], blockers: [], first: [], business: "x", architecture: null,
    findings: [
      { headline: "use", level: "risk", priority: "blocker", title: "Not for production", text: "x", action: "x", quotes: [{ file: "README.md", text: "Only for personal use, not production." }] },
    ],
    disputes: [{ id: "setup.migrations", reason: "The server runs them at startup.", quotes: [{ file: "README.md", text: "Migrations run automatically when the server starts." }] }, { id: "made.up", reason: "x", quotes: [{ file: "README.md", text: "Migrations run automatically when the server starts." }] }],
  } }) } };
  const r = await aiReview(f, [rule], { client: fake as never });
  assert.ok(!("failed" in r));
  if ("failed" in r) return;
  assert.equal(r.findings[0].priority, "improvement");
  assert.deepEqual(r.disputes.map((d) => d.id), ["setup.migrations"]);
  const { applyDisputes } = await import("../lib/inspection/index");
  const [after] = applyDisputes([rule], r.disputes);
  assert.equal(after.priority, "improvement");
  assert.match(after.title, /likely a false alarm/);
});

test("look at these first: archived before blockers, security before continuity", async () => {
  const { fixFirst } = await import("../lib/inspection/labels");
  const mk = (id: string, section: Finding["section"], priority: Finding["priority"]) => ({ id, section, level: "note", status: "concern", priority, title: id, text: id }) as Finding;
  const report = { findings: [mk("control.absence", "control", "important"), mk("deps.direct", "dependencies", "important"), mk("setup.scripts", "setup", "blocker"), mk("activity.archived", "activity", "important")] } as never;
  assert.deepEqual(fixFirst(report).map((x) => x.id), ["activity.archived", "setup.scripts", "deps.direct", "control.absence"]);
});

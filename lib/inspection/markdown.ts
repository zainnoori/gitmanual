import { ARCH_NOTE, BUCKETS, GRADE_LABEL, KIND_LABEL, LEVEL_LABEL, ORDER, PRIORITY_LABEL, SECTION_LABEL, STATUS_LABEL, coverageLines, limited, rankOf, setupFindings, verified, vulnNote, vulnPackages, bucketOf, fixFirst, triage, verdict } from "./labels";
import { HEADLINE, type Audience, type Finding, type GradeId, type Inspection } from "./types";

// The whole report as Markdown, for pasting into an issue, a doc or a chat when testing or giving feedback. Same
// order and words as the page, plus each finding's id so feedback can point at the exact check. Each finding is
// written out once: "Key findings" points at the checks by id instead of repeating them.

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
// Keep the repo's text from breaking the layout: one line, no stray table pipes.
const line = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
const cell = (s: string) => line(s).replace(/\|/g, "\\|");
const list = (xs: string[], ordered = false) => xs.map((x, i) => `${ordered ? `${i + 1}.` : "-"} ${line(x)}`).join("\n");

function finding(x: Finding): string {
  const status = STATUS_LABEL[x.status ?? "info"];
  const tags = [status, x.priority && PRIORITY_LABEL[x.priority], SECTION_LABEL[x.section], x.kind && KIND_LABEL[x.kind]].filter(Boolean).join(" · ");
  const out = [`#### ${line(x.title)}`, "", `${tags} · \`${x.id}\``, "", line(x.text)];
  if (x.quote) out.push("", `> ${line(x.quote)}`);
  if (x.action) out.push("", `**Next step:** ${line(x.action)}`);
  if (x.evidence?.length) out.push("", `Evidence: ${x.evidence.map((e) => (e.url ? `[${e.label}](${e.url})` : `\`${e.label}\``)).join(", ")}`);
  return out.join("\n");
}

export function toMarkdown(report: Inspection, audience: Audience = "personal"): string {
  const f = report.facts;
  const s = report.scope;
  const out: string[] = [];
  const add = (...xs: string[]) => out.push(...xs.flatMap((x) => [x, ""]));

  add(`# Deep Inspection: ${report.repo}`);
  add(
    [
      `- Repo: ${f.repo.htmlUrl}${f.repo.description ? ` (${line(f.repo.description)})` : ""}`,
      `- Inspected: ${day(report.scannedAt)}${s ? `, branch \`${s.branch}\`${s.commit ? ` at commit [\`${s.commit.slice(0, 7)}\`](${f.repo.htmlUrl}/tree/${s.commit})` : ""}` : ""}`,
      report.kind ? `- Looks like: ${report.kind.label}${report.kind.why ? ` (${line(report.kind.why)})` : ""}` : "",
      `- Ordered for: ${audience === "business" ? "a business" : "personal use"}`,
      `- Report version: ${report.version}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const lim = limited(report);
  if (lim) add(`> **${lim}**`);

  // The call and the counts first, as on the page.
  const v = verdict(report);
  const t = triage(report);
  add(
    `## ${v.title}`,
    v.text,
    BUCKETS.filter((b) => b.id !== "info").map((b) => `${b.label}: **${t[b.id]}**`).join(" · "),
  );
  const first = fixFirst(report);
  if (first.length) {
    const urgent = t.blocker + t.important;
    add(
      urgent ? "## Look at these first" : "## Nothing urgent found",
      list(
        first.map((x) => `**${line(x.title)}** (${BUCKETS.find((b) => b.id === bucketOf(x))!.label.replace(/s$/, "")}, ${SECTION_LABEL[x.section]}).${x.action ? ` ${line(x.action)}` : ""} Details: \`${x.id}\`.`),
        true,
      ),
    );
  }

  const d = report.decision;
  if (d) {
    add("## What it is", line(d.does));
    if (d.business) add(`**For a business:** ${line(d.business)}`);
    if (!lim) add(verified(report));
    if (d.needs.length) add("### What you need", list(d.needs));
    add("### Blockers and open questions", d.blockers.length ? list(d.blockers) : "None found in the files read.");
    if (d.first.length) add("### Start here", list(d.first, true));
  } else if (report.summary) add("## Summary", line(report.summary[audience]), verified(report));

  const grades = (Object.keys(GRADE_LABEL) as GradeId[]).map((id) => {
    const g = report.grades.parts[id];
    return `| ${GRADE_LABEL[id]} | ${g?.grade ?? "–"} | ${g ? cell(`${g.held ? (g.grade === "A" ? "Minor: " : "Held back by: ") : ""}${g.reasons.join(" · ")}`) : "Not enough to grade"} |`;
  });
  add("## Grades", ["| Area | Grade | Why |", "| --- | --- | --- |", ...grades].join("\n"), "_Each grade comes from the findings listed under it; there's no hidden score. Setup checks aren't graded._");

  const setup = setupFindings(report);
  if (setup.length) {
    const na = report.findings.find((x) => x.id === "setup.na");
    add("## Before you run it", `What the docs say, checked against what the files show${report.kind ? ` for ${report.kind.label}` : ""}.${na ? ` ${line(na.text)}` : ""}`);
    const steps = report.steps ?? [];
    if (steps.length) {
      const byId = new Map(report.findings.map((x) => [x.id, x]));
      const PHASE: Record<string, string> = { get: "Get the code", install: "Install", configure: "Configure", services: "Start services", database: "Set up the database", build: "Build", run: "Run it" };
      add(
        "### The documented steps",
        list(
          steps.map((st) => {
            const issues = st.findings.map((id) => byId.get(id)).filter((x) => x && ["blocker", "important", "improvement"].includes(bucketOf(x)));
            return `**${PHASE[st.phase]}:** ${st.command ? `\`${st.command}\` (${st.doc}:${st.line})` : "no documented step"}${issues.length ? ` · ${issues.map((x) => `${x!.title} (\`${x!.id}\`)`).join("; ")}` : ""}`;
          }),
          true,
        ),
      );
    }
    for (const x of setup) add(finding(x));
  }

  const a = report.architecture;
  if (a) {
    add("## How it fits together", `${line(a.summary)} _${ARCH_NOTE}_`);
    add(a.parts.map((p) => `- **${line(p.name)}**: ${line(p.role)} (${p.paths.map((x) => `\`${x}\``).join(", ")})`).join("\n"));
    if (a.links?.length) add(`Links: ${a.links.map((l) => `${line(l.from)} → ${line(l.to)}${l.label ? ` (${line(l.label)})` : ""}`).join("; ")}.`);
  }

  const byId = new Map(report.findings.map((x) => [x.id, x]));
  const answers = ORDER[audience].map((id) => report.headline.find((x) => x.id === id)).filter((x) => x !== undefined);
  if (answers.length) {
    add("## Key findings");
    for (const ans of answers) {
      const q = HEADLINE.find((h) => h.id === ans.id)!.q;
      const hits = ans.findings.map((id) => byId.get(id)).filter((x) => x !== undefined);
      const lead = hits.find((x) => x.title === ans.verdict) ?? hits[0];
      // The lead finding's sentence, then where the details are; only answers with no finding behind them say more.
      const body = lead ? `${line(lead.text)}${hits.length ? ` Details: ${hits.map((x) => `\`${x.id}\``).join(", ")}.` : ""}` : line(ans.text);
      add(`- **${q}:** ${line(ans.verdict)} (${LEVEL_LABEL[ans.level]}). ${body}`);
    }
  }

  // Every other check, grouped by section, most serious first. Setup checks were written out above.
  const shownAbove = new Set(setup.map((x) => x.id));
  add("## Every other check", "Grouped by section, most serious first. The setup checks are under \"Before you run it\".");
  const sections = [...new Set(report.findings.map((x) => x.section))];
  for (const sec of sections) {
    const mine = report.findings.filter((x) => x.section === sec && x.id !== "setup.kind" && !shownAbove.has(x.id)).sort((p, q) => rankOf(p) - rankOf(q));
    if (!mine.length) continue;
    add(`### ${SECTION_LABEL[sec]}`);
    for (const x of mine) add(finding(x));
  }

  const vulns = vulnPackages(report);
  if (vulns.length) {
    const ids = (p: (typeof vulns)[number]) => {
      const shown = p.advisories.slice(0, 3).map((a) => `[${a.alias ?? a.id}](${a.url})`).join(", ");
      return `${shown}${p.count > 3 ? ` and ${p.count - 3} more` : ""}`;
    };
    add(
      "## Dependencies with known flaws",
      ["| Package | Version | Worst | Advisories | Scope | Update to |", "| --- | --- | --- | --- | --- | --- |",
        ...vulns.map((p) => `| \`${cell(p.pkg)}\` (${p.ecosystem}) | ${cell(p.versions)} | ${p.worst} | ${p.count}: ${ids(p)} | ${p.scope} | ${cell(p.fixAll)} |`)].join("\n"),
      `_${vulnNote(report)}_`,
    );
  }

  add("## What was inspected");
  add(
    list([
      ...(s?.commit ? [`Branch ${s.branch} at commit ${s.commit.slice(0, 7)}; every file link points at that commit.`] : []),
      ...coverageLines(report).map((c) => `**${c.label}:** ${c.text}`),
      ...(s?.skipped.length ? [`**Not read:** ${s.skipped.map((k) => `${k.count.toLocaleString("en-US")} ${k.reason}`).join("; ")}.`] : []),
    ]),
  );
  if (report.unavailable.length) add("### Couldn't check this time", list(report.unavailable));
  add(
    "### Where it comes from",
    "GitHub (files at the inspected commit, history, CI results), OpenSSF Scorecard, OSV.dev, deps.dev and the npm, PyPI and crates.io download counts. Setup, settings and secret checks are gitmanual's own rules. Claude writes the summary and may add findings; each one quotes the repo's files, checked word for word, and its fixes are labelled as suggestions.",
  );
  add(`_From [gitmanual](https://gitmanual.com/${report.repo}/inspection)._`);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

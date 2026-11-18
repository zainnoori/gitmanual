"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ARCH_NOTE, BUCKETS, GRADE_LABEL, KIND_LABEL, LEVEL_LABEL, ORDER, SECTION_LABEL, STATUS_LABEL, bucketOf, counted, coverageLines, fixFirst, limited, rankOf, setupFindings, triage, verdict, vulnNote, vulnPackages, vulnRows, type Bucket, type Teaser } from "@/lib/inspection/labels";
import { toMarkdown } from "@/lib/inspection/markdown";
import type { Answer, Audience, Finding, GradeId, Inspection, Level, SectionId, StepPhase } from "@/lib/inspection/types";
import { ArchitectureDiagram, ContinuityBars, ReleaseTimeline, RepliesChart, StarHistory } from "./inspection-charts";
import { SevIcon } from "./sev-icon";
import { PaymentPending, REPO_PRICE, UnlockChoice } from "./buy-repo";
import { FoundLine, INSPECTION_CHECKS } from "./inspect-dialog";
import { GitHubMark } from "./github-mark";
import { HEADLINE } from "@/lib/inspection/types";

// Deep Inspection (Pro): the report page. Pro members see the saved report straight away (and a fresh one is built
// when there's none, or it's a few days old); everyone else sees what it covers and the way to Pro.

type Status = { signedIn: boolean; login?: string | null; pro: boolean; bought?: boolean; left?: number | null; inspection: Inspection | null; fresh?: boolean; teaser?: Teaser | null };

const AUDIENCE_KEY = "gitmanual-inspection-audience";

const STEPS = ["Downloading the repo at its latest commit", "Checking the setup steps against the files", "Scanning settings, services and keys", "Checking dependencies and CI results", "Writing it up"];

const ago = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 2 ? "just now" : m < 60 ? `${m} minutes ago` : m < 48 * 60 ? `${Math.round(m / 60)} hours ago` : `${Math.round(m / 1440)} days ago`;
};

export function InspectionView({ repo }: { repo: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [report, setReport] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audience, setAudience] = useState<Audience>("personal");

  useEffect(() => {
    try {
      const a = localStorage.getItem(AUDIENCE_KEY);
      if (a === "personal" || a === "business") setAudience(a);
    } catch {}
  }, []);
  const choose = (a: Audience) => {
    setAudience(a);
    try {
      localStorage.setItem(AUDIENCE_KEY, a);
    } catch {}
  };

  async function run(rescan = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inspection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo, rescan }) });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.inspection) setReport(j.inspection);
      else setError(j.error ?? "The inspection didn't finish. Try again in a minute.");
    } catch {
      setError("Couldn't reach gitmanual. Check your connection and try again.");
    }
    setBusy(false);
  }

  useEffect(() => {
    fetch(`/api/inspection?repo=${encodeURIComponent(repo)}&view=1`, { cache: "no-store" })
      .then((r) => r.json())
      .then((s: Status) => {
        setStatus(s);
        if (!s.pro && !s.bought) return;
        if (s.inspection) setReport(s.inspection);
        // None yet, or a few days old: make one now (the old one stays on screen meanwhile).
        if (!s.inspection || !s.fresh) run();
      })
      .catch(() => setError("Couldn't reach gitmanual. Check your connection and try again."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo]);

  const [owner, name] = repo.split("/");
  const has = Boolean(status?.pro || status?.bought);
  // Back from buying this repo's report (app/api/pro/report/done adds ?bought=1).
  const [justBought, setJustBought] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (!q.has("bought")) return;
    setJustBought(q.get("bought"));
    q.delete("bought");
    window.history.replaceState(null, "", `${window.location.pathname}${q.size ? `?${q}` : ""}${window.location.hash}`);
  }, []);
  return (
    <article className="wrap insp">
      <header className="insp-head">
        <p className="eyebrow">
          <span className="insp-pro">Pro</span> Deep Inspection
        </p>
        <div className="insp-title-row">
          <h1 className="display-md">
            {owner}/<b>{name}</b>
          </h1>
          {report && <AudienceToggle audience={audience} onAudience={choose} />}
        </div>
        <p className="insp-sub">
          What you&apos;re getting into: what it needs to run, where its docs and files disagree, and what to check before you rely on it.{" "}
          <Link href={`/${repo}`}>Back to the setup manual</Link>
        </p>
      </header>

      {justBought && status && !has && <PaymentPending />}
      {justBought && status?.bought && (
        <p className="pro-thanks" role="status">
          Thank you! This report is yours, with the PDF manuals for {name}. Find them any time in{" "}
          <Link href="/profile/reports">Your reports</Link>.
        </p>
      )}
      {!status && !error && <Skeleton />}
      {status && !has && <Locked repo={repo} signedIn={status.signedIn} login={status.login ?? null} teaser={status.teaser ?? null} />}
      {error && !busy && (
        <div className="insp-error" role="alert">
          <p>{error}</p>
          {has && (
            <button className="btn" onClick={() => run()}>
              Try again
            </button>
          )}
        </div>
      )}
      {has && busy && !report && <Working />}
      {report && <Report report={report} audience={audience} busy={busy} onRescan={status?.pro ? () => run(true) : undefined} left={status?.left ?? null} />}
    </article>
  );
}

// Who the report is ordered for, next to the title.
function AudienceToggle({ audience, onAudience }: { audience: Audience; onAudience: (a: Audience) => void }) {
  return (
    <div className="pro-toggle" role="radiogroup" aria-label="Who it's for">
      {(["personal", "business"] as Audience[]).map((a) => (
        <button key={a} type="button" role="radio" aria-checked={audience === a} className={audience === a ? "on" : ""} onClick={() => onAudience(a)}>
          {a === "personal" ? "For me" : "For a business"}
        </button>
      ))}
    </div>
  );
}

function Working() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 3500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="insp-working" role="status" aria-live="polite">
      <span className="spinner" />
      <div>
        <strong>Inspecting…</strong>
        <ol>
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? "done" : i === step ? "now" : ""}>
              {s}
            </li>
          ))}
        </ol>
        <small>Usually 20 to 40 seconds. The finished report is saved, so it opens instantly next time.</small>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="insp-skeleton" aria-busy="true">
      <i />
      <i />
      <i />
    </div>
  );
}

// Signed out: sign in with GitHub first (it comes straight back here), the same as downloading a manual. Signed in
// without Pro: the offer, addressed to them.
function Locked({ repo, signedIn, login, teaser }: { repo: string; signedIn: boolean; login: string | null; teaser: Teaser | null }) {
  const signIn = `/api/github/connect?signin=1&back=${encodeURIComponent(`/${repo}/inspection`)}`;
  return (
    <section className="insp-locked" aria-labelledby="insp-locked-h">
      <div className="insp-locked-sketch" aria-hidden="true">
        <div className="insp-grades">
          {["A", "B", "C", "A"].map((g, i) => (
            <div key={i} className="insp-grade blur">
              <b>{g}</b>
              <i />
            </div>
          ))}
        </div>
        <ul className="insp-rows">
          {HEADLINE.slice(0, 6).map((h) => (
            <li key={h.id}>
              <span>{h.q}</span>
              <i />
            </li>
          ))}
        </ul>
      </div>
      <div className="insp-locked-card">
        {signedIn && login && <p className="insp-locked-hi">Hi @{login}</p>}
        <h2 id="insp-locked-h">Find the gaps before you install it</h2>
        <p>Deep Inspection reads the whole repo and checks its setup against its own files. Each finding links to the lines behind it.</p>
        {teaser && <FoundLine t={teaser} />}
        <ul className="inspect-checks">
          {INSPECTION_CHECKS.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        {signedIn ? (
          <UnlockChoice repo={repo} back={`/${repo}/inspection`} />
        ) : (
          <>
            <a className="btn btn-go pro-btn" href={signIn}>
              <GitHubMark /> Sign in with GitHub to continue
            </a>
            <small>Free to sign in. Then unlock this repo&apos;s Deep Inspection and PDF manuals for {REPO_PRICE} once, or every repo&apos;s with Pro.</small>
          </>
        )}
      </div>
    </section>
  );
}

type FilterId = "concerns" | Bucket | "all";
const CONCERN: Bucket[] = ["blocker", "important", "improvement"];
const FILTERS: { id: FilterId; label: string; test: (x: Finding) => boolean }[] = [
  { id: "concerns", label: "All concerns", test: (x) => CONCERN.includes(bucketOf(x)) },
  { id: "blocker", label: "Blockers", test: (x) => bucketOf(x) === "blocker" },
  { id: "important", label: "Important", test: (x) => bucketOf(x) === "important" },
  { id: "improvement", label: "Improvements", test: (x) => bucketOf(x) === "improvement" },
  { id: "pass", label: "Passed", test: (x) => bucketOf(x) === "pass" },
  { id: "unchecked", label: "Not checked", test: (x) => bucketOf(x) === "unchecked" || x.status === "n/a" },
  { id: "info", label: "Context", test: (x) => bucketOf(x) === "info" && x.status !== "n/a" },
  { id: "all", label: "All", test: () => true },
];

function Report({
  report,
  audience,
  busy,
  onRescan,
  left,
}: {
  report: Inspection;
  audience: Audience;
  busy: boolean;
  onRescan?: () => void; // Pro only; a bought report is rebuilt when it gets old
  left: number | null;
}) {
  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const answers = ORDER[audience].map((id) => report.headline.find((a) => a.id === id)).filter((a): a is Answer => Boolean(a));
  const f = report.facts;
  const setup = setupFindings(report);
  const na = report.findings.find((x) => x.id === "setup.na");
  const setupConcerns = setup.filter((x) => CONCERN.includes(bucketOf(x)) || bucketOf(x) === "unchecked");
  const setupOk = setup.filter((x) => !setupConcerns.includes(x));
  // The twelve questions, worst answer first; the reader's order breaks ties.
  const LEVEL_RANK: Record<Level, number> = { risk: 0, note: 1, neutral: 2, good: 3 };
  const tiles = [...answers].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
  // A count in the summary opens "Every check" on just those.
  const [filter, setFilter] = useState<FilterId>("concerns");
  const pick = (f: FilterId) => {
    setFilter(f);
    requestAnimationFrame(() => {
      const h = document.getElementById("insp-all-h");
      h?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      h?.focus({ preventScroll: true });
    });
  };
  return (
    <>
      <div className="insp-bar">
        <p className="insp-stamp">
          <ScopeLine report={report} /> · Inspected {ago(report.scannedAt)}
          {busy ? (
            <>
              {" "}
              · <span className="spinner" /> Updating…
            </>
          ) : (
            onRescan && (
            <>
              {" "}
              ·{" "}
              <button className="link" onClick={onRescan} title={left !== null ? `${left} new inspections left today` : undefined}>
                Inspect again
              </button>
            </>
            )
          )}
          {" "}
          · <MarkdownExport report={report} audience={audience} />
        </p>
      </div>

      <SectionNav report={report} />
      <TriageCard report={report} audience={audience} onPick={pick} />
      <FixFirst report={report} onPick={pick} />
      {report.decision && <PlanCard report={report} />}

      <section className="insp-section" aria-labelledby="insp-grades-h">
        <h2 id="insp-grades-h" className="insp-h2">
          Project health
        </h2>
        <p className="insp-lede">Each grade comes from the findings listed under it; there&apos;s no hidden score. Setup checks aren&apos;t graded: they&apos;re listed above as blockers and concerns.</p>
        <div className="insp-grades">
          {(Object.keys(GRADE_LABEL) as GradeId[]).map((id) => {
            const g = report.grades.parts[id];
            return (
              <div key={id} className={`insp-grade g-${g?.grade ?? "none"}`}>
                <span>{GRADE_LABEL[id]}</span>
                <b>{g?.grade ?? "–"}</b>
                {g && (
                  <span className="insp-meter" role="img" aria-label={`Score ${g.score} of 100`}>
                    <i style={{ width: `${g.score}%` }} />
                  </span>
                )}
                <small>{g ? `${g.held ? (g.grade === "A" ? "Minor: " : "Held back by: ") : ""}${g.reasons.join(" · ")}` : "Not enough to grade"}</small>
              </div>
            );
          })}
        </div>
      </section>

      {setup.length > 0 && (
        <section aria-labelledby="insp-setup-h" className="insp-section">
          <h2 id="insp-setup-h" className="insp-h2">
            Before you run it
          </h2>
          <p className="insp-lede">
            What the docs say, checked against what the files show{report.kind ? ` for ${report.kind.label}` : ""}.
            {na ? ` ${na.text}` : ""}
          </p>
          <SetupPath report={report} />
          <div className="insp-checks">
            {setupConcerns.map((x) => (
              <FindingCard key={x.id} finding={x} />
            ))}
          </div>
          {setupOk.length > 0 && <Passed findings={setupOk} />}
        </section>
      )}

      {report.architecture && <ArchitectureCard report={report} />}

      <section aria-labelledby="insp-h" className="insp-section">
        <h2 id="insp-h" className="insp-h2">
          Key findings
        </h2>
        <p className="insp-lede">Twelve questions about the project, the ones that need a closer look first. Open one for the evidence.</p>
        <ul className="insp-tiles">
          {tiles.map((a) => (
            <AnswerTile key={a.id} answer={a} findings={a.findings.map((id) => byId.get(id)).filter((x): x is Finding => Boolean(x))} />
          ))}
        </ul>
      </section>

      <AllChecks findings={report.findings} filter={filter} setFilter={setFilter} />

      <h2 id="insp-charts-h" className="insp-h2 insp-section">
        Activity and adoption
      </h2>
      <div className="insp-details">
        {f.weeks && <Activity weeks={f.weeks} />}
        <ReleaseTimeline report={report} />
        <RepliesChart report={report} />
        {f.contributors && f.contributors.length > 0 && <People report={report} />}
        {f.scorecard && <Scorecard report={report} />}
        <StarHistory report={report} />
        {f.deps && f.deps.vulnerable.length > 0 && <Vulns report={report} />}
      </div>

      <section className="insp-foot" aria-labelledby="insp-cant">
        <div>
          <h2 id="insp-scope">What was inspected</h2>
          <Scope report={report} />
          <h2 id="insp-cant">What this couldn&apos;t check</h2>
          <ul>
            {report.unavailable.map((u) => (
              <li key={u}>{u}</li>
            ))}
            <li>Private security alerts (Dependabot, secret and code scanning), traffic and branch rules: GitHub shows these only to the repo&apos;s admins.</li>
            <li>Whether it actually installs and runs: nothing was executed. Findings come from its files, its history and the services that track it.</li>
          </ul>
        </div>
        <div>
          <h2>Where it comes from</h2>
          <p>
            GitHub (files at the inspected commit, history, CI results), <a href="https://scorecard.dev" target="_blank" rel="noreferrer">OpenSSF Scorecard</a>,{" "}
            <a href="https://osv.dev" target="_blank" rel="noreferrer">OSV.dev</a>, <a href="https://deps.dev" target="_blank" rel="noreferrer">deps.dev</a> and the
            npm, PyPI and crates.io download counts. Setup, settings and secret checks are gitmanual&apos;s own rules. Claude writes the summary and may add
            findings; each one quotes the repo&apos;s files, checked word for word, and its fixes are labelled as suggestions. A correct quote doesn&apos;t
            prove a conclusion, so use it to decide what to look at closely.
          </p>
        </div>
      </section>
    </>
  );
}

// The report as Markdown, for testing and feedback: copied to the clipboard or saved as a .md file.
function MarkdownExport({ report, audience }: { report: Inspection; audience: Audience }) {
  const [copied, setCopied] = useState<"" | "ok" | "fail">("");
  const name = `${report.repo.replace("/", "-")}-inspection.md`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toMarkdown(report, audience));
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
    setTimeout(() => setCopied(""), 2500);
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([toMarkdown(report, audience)], { type: "text/markdown;charset=utf-8" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <button className="link" onClick={copy} aria-live="polite">
        {copied === "ok" ? "Copied" : copied === "fail" ? "Couldn't copy" : "Copy Markdown"}
      </button>{" "}
      ·{" "}
      <button className="link" onClick={download}>
        Download .md
      </button>
    </>
  );
}

function ScopeLine({ report }: { report: Inspection }) {
  const s = report.scope;
  if (!s) return null;
  return (
    <span>
      {s.branch}
      {s.commit && (
        <>
          {" @ "}
          <a href={`${report.facts.repo.htmlUrl}/tree/${s.commit}`} target="_blank" rel="noreferrer" className="mono">
            {s.commit.slice(0, 7)}
          </a>
        </>
      )}
    </span>
  );
}

function Scope({ report }: { report: Inspection }) {
  const s = report.scope;
  if (!s) return null;
  return (
    <ul className="insp-scope">
      <li>
        Branch <b>{s.branch}</b>
        {s.commit && (
          <>
            {" "}at commit{" "}
            <a href={`${report.facts.repo.htmlUrl}/tree/${s.commit}`} target="_blank" rel="noreferrer" className="mono">
              {s.commit.slice(0, 7)}
            </a>
          </>
        )}
        , on {new Date(report.scannedAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" })}. Every file link points at that commit.
      </li>
      {coverageLines(report).map((c) => (
        <li key={c.label}>
          <b>{c.label}:</b> {c.text}
        </li>
      ))}
      {s.skipped.length > 0 && (
        <li>
          Not read:{" "}
          {s.skipped.map((k, i) => (
            <span key={k.reason} title={k.examples.join("\n")}>
              {i ? "; " : ""}
              {k.count.toLocaleString("en-US")} {k.reason}
            </span>
          ))}
          .
        </li>
      )}
    </ul>
  );
}

function ArchitectureCard({ report }: { report: Inspection }) {
  const a = report.architecture!;
  const at = report.scope?.commit ?? report.facts.repo.defaultBranch;
  return (
    <section className="insp-section" aria-labelledby="insp-arch-h">
      <h2 id="insp-arch-h" className="insp-h2">
        How it fits together
      </h2>
      <p className="insp-lede">
        {a.summary} <span className="insp-kind">{ARCH_NOTE}</span>
      </p>
      <ArchitectureDiagram report={report} />
      <ul className="insp-arch">
        {a.parts.map((p) => (
          <li key={p.name}>
            <strong>{p.name}</strong>
            <span>{p.role}</span>
            <span className="insp-arch-paths">
              {p.paths.map((x) => (
                <a key={x} className="insp-ev" href={`${report.facts.repo.htmlUrl}/tree/${at}/${x}`} target="_blank" rel="noreferrer">
                  {x}
                </a>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const BUCKET_TAG: Record<Bucket, string> = { blocker: "Setup blocker", important: "Important", improvement: "Improvement", pass: "Pass", unchecked: "Not checked", info: "Info" };

function EvidenceLine({ finding: x }: { finding: Finding }) {
  return (
    <p className="insp-evline">
      {x.kind && <span className="insp-kind">{KIND_LABEL[x.kind]}</span>}
      {x.evidence?.map((e, i) =>
        e.url ? (
          <a key={`${i}:${e.url}`} className="insp-ev" href={e.url} target="_blank" rel="noreferrer">
            {e.label}&nbsp;↗
          </a>
        ) : (
          <span key={`${i}:${e.label}`} className="insp-ev">
            {e.label}
          </span>
        ),
      )}
    </p>
  );
}

function FindingCard({ finding: x, open = false }: { finding: Finding; open?: boolean }) {
  const b = bucketOf(x);
  const label = x.status === "n/a" ? STATUS_LABEL["n/a"] : x.status === "not-found" && b === "info" ? STATUS_LABEL["not-found"] : BUCKET_TAG[b];
  return (
    <details className={`insp-check b-${b}`} open={open}>
      <summary>
        <span className={`insp-tag b-${b}`}>
          <SevIcon kind={b} size={14} />
          {label}
        </span>
        <span className="insp-check-title">{x.title}</span>
        <span className="insp-check-sec">{SECTION_LABEL[x.section]}</span>
      </summary>
      <div className="insp-check-body">
        <p>{x.text}</p>
        {x.quote && <q>{x.quote}</q>}
        {x.action && (
          <p className="insp-action">
            <b>Next step:</b> {x.action}
          </p>
        )}
        <EvidenceLine finding={x} />
      </div>
    </details>
  );
}

// The summary at the top: the overall call, every check counted by how much it matters, and how much was read.
function TriageCard({ report, audience, onPick }: { report: Inspection; audience: Audience; onPick: (f: FilterId) => void }) {
  const t = triage(report);
  const v = verdict(report);
  const d = report.decision;
  const s = report.scope;
  const lim = limited(report);
  const shown = BUCKETS.filter((b) => b.id !== "info");
  const segs = shown.filter((b) => t[b.id] > 0);
  const total = counted(report).length;
  const read = s && s.filesInRepo ? Math.max(1, Math.round((s.filesRead / s.filesInRepo) * 100)) : null;
  return (
    <section className={`insp-triage v-${v.tone}`} aria-labelledby="insp-tri-h">
      <div className="insp-tri-top">
        <div className="insp-tri-call">
          <h2 id="insp-tri-h" className={`insp-call v-${v.tone}`}>
            <SevIcon kind={v.tone === "no" ? "blocker" : v.tone === "maybe" ? "important" : "pass"} size={22} />
            {v.title}
          </h2>
          <p className="insp-tri-why">{v.text}</p>
        </div>
        {d && <p className="insp-dec-does">{d.does}</p>}
      </div>
      {audience === "business" && d?.business && <p className="insp-dec-biz">{d.business}</p>}

      <div className="insp-tri-bar">
        <p className="insp-tri-label">
          {total} checks, by how much they matter
        </p>
        <div className="insp-sevbar" role="img" aria-label={segs.map((b) => `${t[b.id]} ${b.label.toLowerCase()}`).join(", ")}>
          {segs.map((b) => (
            <span key={b.id} className={`sb-seg b-${b.id}`} style={{ flexGrow: t[b.id] }} title={`${t[b.id]} ${b.label.toLowerCase()}`} />
          ))}
        </div>
        <ul className="insp-legend">
          {shown.map((b) => (
            <li key={b.id}>
              <button type="button" className={`b-${b.id}`} onClick={() => onPick(b.id)} disabled={!t[b.id]} aria-label={`Show the ${t[b.id]} ${b.label.toLowerCase()}`}>
                <SevIcon kind={b.id} />
                <b className="num">{t[b.id]}</b>
                <span>{b.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="insp-cover">
        {read !== null && (
          <span className="insp-cover-files">
            <span className="insp-cover-meter" role="img" aria-label={`${read}% of files read`}>
              <i style={{ width: `${read}%` }} />
            </span>
            <span className="num">
              {s!.filesRead.toLocaleString("en-US")} of {s!.filesInRepo.toLocaleString("en-US")} files read
            </span>
          </span>
        )}
        <span>
          <SevIcon kind="unchecked" size={14} /> Nothing installed, built or run
        </span>
        <a href="#insp-scope">What was inspected</a>
      </div>
      {lim && <p className="insp-tri-limited">{lim}</p>}
    </section>
  );
}

// The first sentence up front, the rest on request: long explanations made the list hard to scan.
const lead = (t: string) => /^(.+?[.!?])(\s+[A-Z(]|$)/.exec(t)?.[1] ?? t;
const rest = (t: string) => t.slice(lead(t).length).trim();

// A sticky menu of the report's parts, highlighting the one in view, so a long report is easy to move around.
function SectionNav({ report }: { report: Inspection }) {
  const items = [
    ["insp-tri-h", "Summary"],
    ["insp-fix-h", "First"],
    report.decision ? ["insp-plan-h", "Running it"] : null,
    ["insp-grades-h", "Health"],
    report.steps?.length || report.findings.some((x) => SETUP_SECTIONS.includes(x.section)) ? ["insp-setup-h", "Setup"] : null,
    report.architecture ? ["insp-arch-h", "Architecture"] : null,
    ["insp-h", "Findings"],
    ["insp-all-h", "All checks"],
    ["insp-charts-h", "Charts"],
  ].filter((x): x is string[] => Boolean(x));
  const [current, setCurrent] = useState(items[0][0]);
  useEffect(() => {
    const els = items.map(([id]) => document.getElementById(id)).filter((e): e is HTMLElement => Boolean(e));
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setCurrent(top.target.id);
      },
      { rootMargin: "-90px 0px -65% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report]);
  return (
    <nav className="insp-nav" aria-label="Report sections">
      {items.map(([id, label]) => (
        <a key={id} href={`#${id}`} className={current === id ? "on" : undefined} aria-current={current === id ? "true" : undefined}>
          {label}
        </a>
      ))}
    </nav>
  );
}
const SETUP_SECTIONS: SectionId[] = ["setup", "config", "services", "requirements", "secrets", "tests", "deploy"];

// The most serious concerns, in the order to look at them. Numbers here are a real order.
function FixFirst({ report, onPick }: { report: Inspection; onPick: (f: FilterId) => void }) {
  const items = fixFirst(report);
  const t = triage(report);
  const urgent = t.blocker + t.important;
  const concerns = t.blocker + t.important + t.improvement;
  if (!items.length) return null;
  return (
    <section className="insp-section" aria-labelledby="insp-fix-h">
      <h2 id="insp-fix-h" className="insp-h2">
        {urgent ? "Look at these first" : "Nothing urgent found"}
      </h2>
      <p className="insp-lede">
        {urgent
          ? `${urgent > items.length ? `The ${items.length} most serious of ${urgent}` : `The ${urgent === 1 ? "one concern" : `${urgent} concerns`}`} that could stop it from running or matter before you rely on it, most serious first.`
          : "No setup blockers or important concerns were found. These are the smaller improvements worth knowing about."}
      </p>
      <ol className="insp-fix">
        {items.map((x, i) => {
          const b = bucketOf(x);
          return (
            <li key={x.id} className={`b-${b}`} style={{ ["--i" as string]: i }}>
              <span className="insp-fix-n" aria-hidden="true">
                {i + 1}
              </span>
              <div className="insp-fix-body">
                <p className="insp-fix-tag">
                  <span className={`insp-tag b-${b}`}>
                    <SevIcon kind={b} size={14} />
                    {BUCKET_TAG[b]}
                  </span>
                  <span className="insp-check-sec">{SECTION_LABEL[x.section]}</span>
                </p>
                <h3>{x.title}</h3>
                <p>{lead(x.text)}</p>
                {x.action && (
                  <p className="insp-action">
                    <b>Next step:</b> {x.action}
                  </p>
                )}
                {(rest(x.text) || x.quote || x.evidence?.length) && (
                  <details className="insp-more-details">
                    <summary>Why, and the evidence</summary>
                    {rest(x.text) && <p>{rest(x.text)}</p>}
                    {x.quote && <q>{x.quote}</q>}
                    <EvidenceLine finding={x} />
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {concerns > items.length && (
        <button type="button" className="link insp-more" onClick={() => onPick("concerns")}>
          See all {concerns} concerns
        </button>
      )}
    </section>
  );
}

// What it takes to get it running, from Claude's summary: what you need, where to start, what's still open.
function PlanCard({ report }: { report: Inspection }) {
  const d = report.decision!;
  return (
    <section className="insp-section insp-plan" aria-labelledby="insp-plan-h">
      <h2 id="insp-plan-h" className="insp-h2">
        Getting it running
      </h2>
      <div className="insp-plan-cols">
        {d.needs.length > 0 && (
          <div>
            <h3>What you need</h3>
            <ul>
              {d.needs.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {d.first.length > 0 && (
          <div>
            <h3>Start here</h3>
            <ol>
              {d.first.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
          </div>
        )}
        <div>
          <h3>Open questions</h3>
          {d.blockers.length ? (
            <details className="insp-more-details">
              <summary>
                {d.blockers.length} question{d.blockers.length === 1 ? "" : "s"} to check
              </summary>
              <ul>
                {d.blockers.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </details>
          ) : (
            <p>None found in the files read.</p>
          )}
        </div>
      </div>
      <p className="insp-kind">Summarised by Claude from the checks and the files read.</p>
    </section>
  );
}

// The documented way to get it running, step by step, each marked with what the checks found about it.
const PHASE_LABEL: Record<StepPhase, string> = { get: "Get the code", install: "Install", configure: "Configure", services: "Start services", database: "Set up the database", build: "Build", run: "Run it" };
const BUCKET_RANK: Bucket[] = ["blocker", "important", "improvement", "unchecked", "info", "pass"];
function SetupPath({ report }: { report: Inspection }) {
  const steps = report.steps ?? [];
  if (steps.length < 2) return null;
  const byId = new Map(report.findings.map((x) => [x.id, x]));
  const at = report.scope?.commit ?? report.facts.repo.defaultBranch;
  return (
    <ol className="insp-path" aria-label="The documented setup steps">
      {steps.map((st, i) => {
        const found = st.findings.map((id) => byId.get(id)).filter((x): x is Finding => Boolean(x));
        const worst = [...found].sort((a, b) => BUCKET_RANK.indexOf(bucketOf(a)) - BUCKET_RANK.indexOf(bucketOf(b)))[0];
        const b: Bucket = worst && CONCERN.includes(bucketOf(worst)) ? bucketOf(worst) : "pass";
        return (
          <li key={st.phase} className={`b-${b}`}>
            <span className="insp-path-n" aria-hidden="true">
              {i + 1}
            </span>
            <span className="insp-path-label">{PHASE_LABEL[st.phase]}</span>
            {st.command ? (
              <a className="insp-path-cmd" href={`${report.facts.repo.htmlUrl}/blob/${at}/${st.doc}#L${st.line}`} target="_blank" rel="noreferrer" title={`${st.doc}, line ${st.line}`}>
                <code>{st.command}</code>
              </a>
            ) : (
              <span className="insp-path-cmd none">No documented step</span>
            )}
            <span className="insp-path-status">
              <SevIcon kind={b} size={14} />
              {b === "pass" ? "Nothing found against it" : worst!.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Passed and background setup checks, folded away: worth seeing, not worth the space of a concern.
function Passed({ findings }: { findings: Finding[] }) {
  const pass = findings.filter((x) => bucketOf(x) === "pass").length;
  const other = findings.length - pass;
  return (
    <details className="insp-passed">
      <summary>
        <SevIcon kind="pass" />
        {pass ? `${pass} passed` : ""}
        {pass && other ? ", " : ""}
        {other ? `${other} for context` : ""}
        <span className="insp-check-sec">Show</span>
      </summary>
      <ul>
        {findings.map((x) => (
          <li key={x.id}>
            <SevIcon kind={bucketOf(x)} size={14} />
            <span>
              <b>{x.title}</b> {x.text}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function AllChecks({ findings, filter, setFilter }: { findings: Finding[]; filter: FilterId; setFilter: (f: FilterId) => void }) {
  const [section, setSection] = useState<SectionId | "">("");
  const sections = [...new Set(findings.map((x) => x.section))];
  const test = FILTERS.find((x) => x.id === filter)!.test;
  const shown = findings.filter((x) => x.id !== "setup.kind" && test(x) && (!section || x.section === section)).sort((a, b) => rankOf(a) - rankOf(b));
  return (
    <section className="insp-section" aria-labelledby="insp-all-h">
      <h2 id="insp-all-h" className="insp-h2" tabIndex={-1}>
        Every check
      </h2>
      <div className="insp-filters">
        <div className="insp-chips" role="radiogroup" aria-label="Show">
          {FILTERS.filter((x) => x.id === "concerns" || x.id === "all" || x.id === filter || findings.some((y) => y.id !== "setup.kind" && x.test(y))).map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={filter === x.id} className={filter === x.id ? "on" : ""} onClick={() => setFilter(x.id)}>
              {x.label} <span className="num">{findings.filter((y) => y.id !== "setup.kind" && x.test(y) && (!section || y.section === section)).length}</span>
            </button>
          ))}
        </div>
        <label className="insp-select">
          <span className="sr-only">Section</span>
          <select value={section} onChange={(e) => setSection(e.target.value as SectionId | "")}>
            <option value="">All sections</option>
            {sections.map((x) => (
              <option key={x} value={x}>
                {SECTION_LABEL[x]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="insp-checks" aria-live="polite">
        {shown.length ? shown.map((x) => <FindingCard key={x.id} finding={x} />) : <p className="insp-empty">Nothing here. Try another filter.</p>}
      </div>
    </section>
  );
}

// One of the twelve questions as a tile: the answer up front, the evidence when opened.
function AnswerTile({ answer, findings }: { answer: Answer; findings: Finding[] }) {
  const q = HEADLINE.find((h) => h.id === answer.id)!.q;
  const shown = findings.some((x) => x.level !== "neutral") ? findings.filter((x) => x.level !== "neutral" || findings.length === 1) : findings;
  return (
    <li className={`insp-tile l-${answer.level}`}>
      <details>
        <summary>
          <span className="insp-tile-q">{q}</span>
          <span className="insp-tile-a">
            <SevIcon kind={answer.level} />
            {answer.verdict}
          </span>
          <span className="sr-only"> ({LEVEL_LABEL[answer.level]})</span>
          <span className="insp-tile-more" aria-hidden="true">
            {shown.some((x) => x.evidence?.length) ? `Evidence (${shown.reduce((n, x) => n + (x.evidence?.length ?? 0), 0)})` : "Details"}
            <i />
          </span>
        </summary>
        <div className="insp-tile-body">
          {shown.length ? (
            shown.map((x) => (
              <div key={x.id}>
                <p>{x.text}</p>
                {x.quote && <q>{x.quote}</q>}
                <EvidenceLine finding={x} />
              </div>
            ))
          ) : (
            <p>{answer.text}</p>
          )}
        </div>
      </details>
    </li>
  );
}

function Activity({ weeks }: { weeks: number[] }) {
  const max = Math.max(1, ...weeks);
  const total = weeks.reduce((a, b) => a + b, 0);
  return (
    <section className="insp-card insp-wide" aria-labelledby="insp-act">
      <h2 id="insp-act">Commits per week, last 12 months</h2>
      <div className="insp-chart" role="img" aria-label={`${total} commits in the last 52 weeks`}>
        {weeks.map((w, i) => (
          <i key={i} style={{ height: `${Math.max(w ? 6 : 2, (w / max) * 100)}%` }} title={`${w} commit${w === 1 ? "" : "s"}`} className={w ? "" : "zero"} />
        ))}
      </div>
      <p className="note">
        {total.toLocaleString("en-US")} commits · {weeks.filter((w) => w > 0).length} of 52 weeks active
      </p>
    </section>
  );
}

function People({ report }: { report: Inspection }) {
  const people = report.facts.contributors!;
  const total = people.reduce((s, p) => s + p.commits, 0);
  return (
    <section className="insp-card" aria-labelledby="insp-people">
      <h2 id="insp-people">Who writes it</h2>
      <ul className="insp-bars">
        {people.slice(0, 6).map((p) => (
          <li key={p.login}>
            <a href={`https://github.com/${p.login}`} target="_blank" rel="noreferrer">
              @{p.login}
            </a>
            <span className="insp-bar-track">
              <i style={{ width: `${Math.max(2, (p.commits / people[0].commits) * 100)}%` }} />
            </span>
            <span className="num">{Math.round((p.commits / total) * 100)}%</span>
          </li>
        ))}
      </ul>
      <p className="note">{(report.facts.contributorCount ?? people.length).toLocaleString("en-US")} contributors in all; share of commits on the main branch.</p>
      <ContinuityBars report={report} />
    </section>
  );
}

function Vulns({ report }: { report: Inspection }) {
  const rows = vulnRows(report);
  const packages = vulnPackages(report);
  const d = report.facts.deps!;
  const serious = d.vulnerable.filter((v) => /critical|high/i.test(v.severity ?? "")).length;
  return (
    <section className="insp-card insp-vulns" aria-labelledby="insp-vulns">
      <h2 id="insp-vulns">Dependencies with known flaws</h2>
      <VulnCharts rows={rows} detailed={d.vulnerable.some((v) => v.advisories)} />
      <details>
        <summary>
          {d.vulnerable.length} packages, {rows.length} advisories{serious ? `, ${serious} packages with a high or critical one` : ""}. Show the table
        </summary>
        <div className="insp-table-wrap">
          <table className="insp-table">
            <thead>
              <tr>
                <th scope="col">Package</th>
                <th scope="col">Version</th>
                <th scope="col">Worst</th>
                <th scope="col">Advisories</th>
                <th scope="col">Scope</th>
                <th scope="col">Update to</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={`${p.ecosystem}:${p.pkg}`}>
                  <th scope="row">
                    <code>{p.pkg}</code>
                    <small>{p.ecosystem}</small>
                  </th>
                  <td className="mono">{p.versions}</td>
                  <td>
                    <span className={`insp-sev s-${p.worst}`}>{p.worst}</span>
                  </td>
                  <td>
                    {p.count === 1 ? (
                      <>
                        <a href={p.advisories[0].url} target="_blank" rel="noreferrer" className="mono">
                          {p.advisories[0].alias ?? p.advisories[0].id}
                        </a>
                        {p.advisories[0].summary && <small>{p.advisories[0].summary}</small>}
                      </>
                    ) : (
                      <details className="insp-advs">
                        <summary>{p.count} advisories</summary>
                        <ul>
                          {p.advisories.map((a) => (
                            <li key={a.id}>
                              <span className={`insp-sev s-${a.severity}`}>{a.severity}</span>{" "}
                              <a href={a.url} target="_blank" rel="noreferrer" className="mono">
                                {a.alias ?? a.id}
                              </a>
                              {a.summary && <small>{a.summary}</small>}
                              {a.fixed !== "Unknown" && <small>Fixed in {a.fixed}</small>}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td>{p.scope}</td>
                  <td className="mono">{p.fixAll}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <p className="note">{vulnNote(report)}</p>
    </section>
  );
}

// The advisories at a glance: how severe, whether a fix is known, and how they reach the project.
const SEVS = ["critical", "high", "moderate", "low", "unknown"] as const;
function VulnCharts({ rows, detailed }: { rows: ReturnType<typeof vulnRows>; detailed: boolean }) {
  const bySev = SEVS.map((k) => ({ k, n: rows.filter((r) => (r.severity === "medium" ? "moderate" : r.severity) === k).length })).filter((x) => x.n);
  const fixed = rows.filter((r) => r.fixed !== "Unknown").length;
  const pkgs = rows.filter((r) => r.first);
  const scopes = (["Direct", "Development", "Indirect", "Unknown"] as const).map((k) => ({ k, n: pkgs.filter((r) => r.scope === k).length })).filter((x) => x.n);
  return (
    <div className="insp-vcharts">
      <div>
        <p className="insp-tri-label">{rows.length} advisories by severity</p>
        <div className="insp-sevbar small" role="img" aria-label={bySev.map((x) => `${x.n} ${x.k}`).join(", ")}>
          {bySev.map((x) => (
            <span key={x.k} className={`sb-seg s-${x.k}`} style={{ flexGrow: x.n }} title={`${x.n} ${x.k}`} />
          ))}
        </div>
        <ul className="insp-vlegend">
          {bySev.map((x) => (
            <li key={x.k}>
              <i className={`s-${x.k}`} />
              <b className="num">{x.n}</b> {x.k}
            </li>
          ))}
        </ul>
      </div>
      {detailed && (
      <div>
        <p className="insp-tri-label">Fix known</p>
        <p className="insp-vbig">
          <b className="num">{fixed}</b> of {rows.length}
        </p>
        <span className="insp-cover-meter" role="img" aria-label={`${fixed} of ${rows.length} advisories name a fixed version`}>
          <i style={{ width: `${rows.length ? (fixed / rows.length) * 100 : 0}%` }} />
        </span>
      </div>
      )}
      {detailed && (
      <div>
        <p className="insp-tri-label">{pkgs.length} packages, how they come in</p>
        <ul className="insp-vscope">
          {scopes.map((x) => (
            <li key={x.k}>
              <span>{x.k}</span>
              <span className="insp-vscope-bar">
                <i style={{ width: `${(x.n / pkgs.length) * 100}%` }} />
              </span>
              <b className="num">{x.n}</b>
            </li>
          ))}
        </ul>
      </div>
      )}
    </div>
  );
}

function Scorecard({ report }: { report: Inspection }) {
  const s = report.facts.scorecard!;
  const checks = [...s.checks].filter((c) => c.score >= 0).sort((a, b) => a.score - b.score);
  return (
    <section className="insp-card" aria-labelledby="insp-score">
      <h2 id="insp-score">OpenSSF Scorecard: {s.score.toFixed(1)}/10</h2>
      <ul className="insp-bars">
        {checks.slice(0, 8).map((c) => (
          <li key={c.name} title={c.reason}>
            <span>{c.name.replace(/-/g, " ")}</span>
            <span className="insp-bar-track">
              <i style={{ width: `${Math.max(2, c.score * 10)}%` }} className={c.score < 4 ? "low" : ""} />
            </span>
            <span className="num">{c.score}</span>
          </li>
        ))}
      </ul>
      <p className="note">The lowest checks first. Automated, with false alarms both ways.</p>
    </section>
  );
}


"use client";

import { useEffect, useState } from "react";
import type { Problem, ProblemStatus } from "@/lib/db";
import { OS_LABEL, OS_SLUG, type OS } from "@/lib/os";
import { KIND_LABEL } from "@/lib/problems";

type Show = ProblemStatus | "all";
type From = "all" | "contact" | "site" | "manual";
const FROM: { id: From; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "contact", label: "Messages" },
  { id: "site", label: "Site problems" },
  { id: "manual", label: "Manuals" },
];
const SHOW: { id: Show; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "fixed", label: "Fixed" },
  { id: "closed", label: "Closed" },
  { id: "all", label: "All" },
];
const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function ProblemsAdmin() {
  const [show, setShow] = useState<Show>("open");
  const [from, setFrom] = useState<From>("all");
  const [list, setList] = useState<Problem[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [repo, setRepo] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  // Rebuild results per repo: "working", or what happened.
  const [rebuilt, setRebuilt] = useState<Record<string, string>>({});

  async function rebuild(r: string) {
    setRebuilt((m) => ({ ...m, [r]: "working" }));
    const res = await fetch("/api/admin/problems", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rebuild: r }) });
    const j = await res.json().catch(() => ({}));
    setRebuilt((m) => ({ ...m, [r]: res.ok ? `Rebuilt just now (manual v${j.version}). Check it, then reply.` : (j.error ?? "Couldn't rebuild it.") }));
  }

  const load = (s: Show) =>
    fetch(`/api/admin/problems?status=${s}`, { cache: "no-store" }).then(async (r) => {
      if (!r.ok) return setDenied(true);
      setList((await r.json()).problems);
    });
  useEffect(() => {
    setList(null);
    load(show);
  }, [show]);

  async function mark(p: Problem, status: ProblemStatus) {
    await fetch("/api/admin/problems", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: p.id, status }) });
    await load(show);
  }

  if (denied)
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/problems">Sign in with GitHub</a> with an account listed in{" "}
        <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );

  // The repos with the most reports in this list: where a manual (or a detection rule) most needs work.
  const rows = list?.filter((p) => (from === "all" || p.mode === from) && (!repo || p.repo === repo) && (!kind || p.kind === kind)) ?? null;
  const kinds = list ? [...new Set(list.map((p) => p.kind))].sort() : [];
  const top = list
    ? Object.entries(list.reduce<Record<string, number>>((m, p) => ((m[p.repo] = (m[p.repo] ?? 0) + 1), m), {}))
        .filter(([r, n]) => r && n > 1)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
    : [];

  return (
    <>
      <div className="inbox-filters">
        <div className="dl-systems" role="radiogroup" aria-label="Status">
          {SHOW.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={show === s.id} className={show === s.id ? "on" : ""} onClick={() => setShow(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="dl-systems" role="radiogroup" aria-label="From">
          {FROM.map((s) => (
            <button key={s.id} type="button" role="radio" aria-checked={from === s.id} className={from === s.id ? "on" : ""} onClick={() => setFrom(s.id)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {kinds.length > 1 && (
        <p>
          <label>
            Type:{" "}
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All types</option>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k] ?? k}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      {repo ? (
        <p className="note">
          Only <a href={`/${repo}`}>{repo}</a>.{" "}
          <button type="button" className="link" onClick={() => setRepo(null)}>
            Show every repo
          </button>
          {" · "}
          <button type="button" className="link" disabled={rebuilt[repo] === "working"} onClick={() => rebuild(repo)}>
            {rebuilt[repo] === "working" ? "Rebuilding…" : "Rebuild its manual"}
          </button>
          {rebuilt[repo] && rebuilt[repo] !== "working" && <small role="status"> {rebuilt[repo]}</small>}
        </p>
      ) : (
        top.length > 0 && (
          <p className="note">
            Most reported (click to see only those):{" "}
            {top.map(([r, n], i) => (
              <span key={r}>
                {i > 0 && " · "}
                <button type="button" className="link" onClick={() => setRepo(r)}>
                  {r}
                </button>{" "}
                ({n})
              </span>
            ))}
          </p>
        )
      )}
      {!rows ? (
        <p>Loading…</p>
      ) : !rows.length ? (
        <p>Nothing {show === "all" ? "" : show} here.</p>
      ) : (
        <div className="doc-table-wrap">
          <table className="doc-table problems-table">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">About</th>
                <th scope="col">What</th>
                <th scope="col">Report</th>
                <th scope="col">From</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>{when(p.createdAt)}</td>
                  <th scope="row">
                    {p.repo ? <a href={`/${p.repo}${p.os ? `/${OS_SLUG[p.os as OS]}` : ""}`}>{p.repo}</a> : p.mode === "contact" ? "Message" : "Site"}
                    {p.repo && !repo && (
                      <>
                        {" "}
                        <button type="button" className="link" onClick={() => setRepo(p.repo)} aria-label={`Only ${p.repo}`}>
                          only these
                        </button>
                      </>
                    )}
                    <br />
                    <small>
                      {p.os ? `${OS_LABEL[p.os as OS] ?? p.os} · v${p.version}` : p.page ? `from ${p.page}` : ""}
                    </small>
                  </th>
                  <td>
                    {KIND_LABEL[p.kind] ?? p.kind}
                    {p.step && (
                      <>
                        <br />
                        <small>
                          Step {p.step}: {p.stepTitle}
                        </small>
                      </>
                    )}
                  </td>
                  <td className="problems-text">
                    <p>{p.message}</p>
                    {p.error && (
                      <details>
                        <summary>Error</summary>
                        <pre>{p.error}</pre>
                      </details>
                    )}
                  </td>
                  <td>
                    {p.githubLogin && <a href={`/admin/user?login=${encodeURIComponent(p.githubLogin)}`}>@{p.githubLogin}</a>}
                    {p.githubLogin && p.email && <br />}
                    {p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}
                    {p.name && (
                      <>
                        <br />
                        <small>{p.name}</small>
                      </>
                    )}
                    {!p.githubLogin && !p.email && <small>Anonymous</small>}
                    <br />
                    <a className="btn btn-sm em-row" href={`/admin/email?kind=problem&id=${p.id}`}>
                      {p.email ? "Reply" : "Email…"}
                    </a>
                    {p.repliedAt && (
                      <>
                        <br />
                        <small className="replied">Replied {when(p.repliedAt)}</small>
                      </>
                    )}
                  </td>
                  <td className="problems-act">
                    {p.repo && (
                      <>
                        <button type="button" className="link" disabled={rebuilt[p.repo] === "working"} onClick={() => rebuild(p.repo)} title="Read the repo from GitHub again and save the new manual">
                          {rebuilt[p.repo] === "working" ? "Rebuilding…" : "Rebuild manual"}
                        </button>
                        {rebuilt[p.repo] && rebuilt[p.repo] !== "working" && (
                          <>
                            <br />
                            <small role="status">{rebuilt[p.repo]}</small>
                          </>
                        )}
                        <br />
                        <a className="link" href={`/admin/repos?repo=${encodeURIComponent(p.repo)}`}>
                          Take down…
                        </a>
                        <br />
                      </>
                    )}
                    {p.status === "open" ? (
                      <>
                        <button className="btn btn-sm" onClick={() => mark(p, "fixed")}>
                          Fixed
                        </button>
                        <button className="link" onClick={() => mark(p, "closed")}>
                          Close
                        </button>
                      </>
                    ) : (
                      <button className="link" onClick={() => mark(p, "open")}>
                        Reopen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

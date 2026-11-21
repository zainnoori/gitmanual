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
  const rows = list?.filter((p) => from === "all" || p.mode === from) ?? null;
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
      {top.length > 0 && (
        <p className="note">
          Most reported: {top.map(([r, n], i) => (
            <span key={r}>
              {i > 0 && " · "}
              <a href={`/${r}`}>{r}</a> ({n})
            </span>
          ))}
        </p>
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
                    {p.githubLogin && (
                      <a href={`https://github.com/${p.githubLogin}`} target="_blank" rel="noreferrer">
                        @{p.githubLogin}
                      </a>
                    )}
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
                  </td>
                  <td className="problems-act">
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

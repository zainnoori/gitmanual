"use client";

import { useEffect, useState } from "react";
import type { GoneRepo } from "@/lib/db";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export function ReposAdmin({ initial }: { initial: string }) {
  const [repos, setRepos] = useState<GoneRepo[] | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);
  const [repo, setRepo] = useState(initial);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = () =>
    fetch("/api/admin/repos", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load the list.");
      setRepos(j.repos);
    });
  useEffect(() => {
    void load();
  }, []);

  async function act(target: string, action: "hide" | "unhide", why = "") {
    setBusy(target);
    setDone(null);
    setError(null);
    const r = await fetch("/api/admin/repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: target, action, note: why }) }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    setBusy(null);
    if (!r?.ok) return setError(j.error ?? "Couldn't reach gitmanual. Try again.");
    setDone(action === "hide" ? `${target} is taken down.` : `${target} is back on the shelf.`);
    if (action === "hide") {
      setRepo("");
      setNote("");
    }
    void load();
  }

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/repos">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );

  const hidden = repos?.filter((r) => r.reason === "hidden") ?? [];
  const gone = repos?.filter((r) => r.reason === "github") ?? [];
  return (
    <>
      <h2>Take a manual down</h2>
      <p>
        Its manual, inspection, downloads, badge and API answers stop working, and it leaves the shelf, lists and sitemap. Buyers
        can&apos;t open it either. Use it for repos that spread malware or copy someone else&apos;s project.
      </p>
      <form
        className="admin-find"
        onSubmit={(e) => {
          e.preventDefault();
          if (repo.trim()) void act(repo.trim(), "hide", note);
        }}
      >
        <input aria-label="Repo" placeholder="owner/name or GitHub link" value={repo} onChange={(e) => setRepo(e.target.value)} size={32} required />
        <input aria-label="Why (only shown here)" placeholder="Why (only shown here)" value={note} onChange={(e) => setNote(e.target.value)} size={28} maxLength={300} />
        <button type="submit" className="btn btn-sm" disabled={busy !== null}>
          {busy === repo.trim() ? "Taking down…" : "Take down"}
        </button>
      </form>
      {done && <p role="status">{done}</p>}
      {error && <p role="alert">{error}</p>}

      <h2>Taken down</h2>
      {!repos ? <p>Loading…</p> : hidden.length ? <Table rows={hidden} busy={busy} act={act} /> : <p>None.</p>}

      <h2>Gone from GitHub</h2>
      <p>
        A re-read found these deleted, private, or with their owner&apos;s account removed. Their manuals still open, with a notice, but
        they&apos;re off the shelf and search. A later re-read that works puts them back on its own. Take one down if it looks harmful.
      </p>
      {!repos ? <p>Loading…</p> : gone.length ? <Table rows={gone} busy={busy} act={act} /> : <p>None yet.</p>}
    </>
  );
}

function Table({ rows, busy, act }: { rows: GoneRepo[]; busy: string | null; act: (repo: string, action: "hide" | "unhide") => void }) {
  return (
    <div className="doc-table-wrap">
      <table className="doc-table">
        <thead>
          <tr>
            <th scope="col">Repo</th>
            <th scope="col">Since</th>
            <th scope="col">Why</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row">
                <a href={`/${r.fullName}`}>{r.fullName}</a>{" "}
                <a href={`https://github.com/${r.fullName}`} target="_blank" rel="noreferrer">
                  GitHub ↗
                </a>
              </th>
              <td>{when(r.at)}</td>
              <td>
                {r.note ?? "—"}
                {r.by && <> (@{r.by})</>}
              </td>
              <td className="admin-row-act">
                {r.reason === "github" && (
                  <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => act(r.fullName, "hide")}>
                    Take down
                  </button>
                )}{" "}
                <button type="button" className="link" disabled={busy !== null} onClick={() => act(r.fullName, "unhide")}>
                  {r.reason === "hidden" ? "Bring back" : "Put back on the shelf"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

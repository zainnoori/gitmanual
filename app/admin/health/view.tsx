"use client";

import { useEffect, useState } from "react";

type Check = { name: string; ok: boolean | null; detail: string };
type Run = Check & { at: number | null };

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
// Words as well as color, so the state never rests on color alone.
const State = ({ ok }: { ok: boolean | null }) => (
  <span className={`health-state ${ok === true ? "ok" : ok === false ? "bad" : "off"}`}>{ok === true ? "OK" : ok === false ? "Problem" : "Off"}</span>
);

export function HealthAdmin() {
  const [d, setD] = useState<{ checks: Check[]; runs: Run[] } | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    fetch("/api/admin/health", { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 403) return setError("denied");
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return setError(j.error ?? "Couldn't check.");
        setD(j);
      })
      .finally(() => setBusy(false));
  };
  useEffect(load, []);

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/health">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (error) return <p role="alert">{error}</p>;
  if (!d) return <p>Checking…</p>;

  return (
    <>
      <p>
        Settings show whether they&apos;re set, never their values.{" "}
        <button type="button" className="link" onClick={load} disabled={busy}>
          {busy ? "Checking…" : "Check again"}
        </button>
      </p>
      <h2>Parts</h2>
      <div className="doc-table-wrap">
        <table className="doc-table">
          <tbody>
            {d.checks.map((c) => (
              <tr key={c.name}>
                <th scope="row">{c.name}</th>
                <td>
                  <State ok={c.ok} />
                </td>
                <td>{c.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Background jobs</h2>
      <div className="doc-table-wrap">
        <table className="doc-table">
          <thead>
            <tr>
              <th scope="col">Job</th>
              <th scope="col">State</th>
              <th scope="col">Last run</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {d.runs.map((r) => (
              <tr key={r.name}>
                <th scope="row">{r.name}</th>
                <td>
                  <State ok={r.ok} />
                </td>
                <td>{r.at ? when(r.at) : "–"}</td>
                <td>{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

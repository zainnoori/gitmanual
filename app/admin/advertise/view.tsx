"use client";

import { useEffect, useState } from "react";
import { AD_LIMITS, type AdNumber, type AdStats } from "@/lib/advertise";

type Group = "site" | "social";
const GROUPS: [Group, string, string][] = [
  ["site", "Site analytics (gitmanual.com)", "From Vercel → Analytics, last 30 days, e.g. 48,200 · visitors in the last 30 days"],
  ["social", "Zain Finds", "From the page's insights, e.g. 6M+ · views in the last 28 days"],
];

export function AdvertiseAdmin() {
  const [s, setS] = useState<AdStats | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");

  useEffect(() => {
    fetch("/api/admin/advertise", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load.");
      const stats: AdStats = j.stats;
      // Nothing saved for the site yet: start with the two usual rows, ready for the numbers.
      if (!stats.site.length) stats.site = [{ value: "", label: "visitors in the last 30 days" }, { value: "", label: "page views in the last 30 days" }];
      setS(stats);
    });
  }, []);

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/advertise">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (!s) return error ? <p role="alert">{error}</p> : <p>Loading…</p>;

  const edit = (next: AdStats) => {
    setS(next);
    setState("idle");
  };
  const setRow = (g: Group, i: number, row: Partial<AdNumber>) => edit({ ...s, [g]: s[g].map((n, k) => (k === i ? { ...n, ...row } : n)) });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState("saving");
    setError(null);
    const r = await fetch("/api/admin/advertise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(s) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      setError(j.error ?? "Couldn't save.");
      return setState("idle");
    }
    setS(j.stats);
    setState("saved");
  }

  return (
    <form className="adv-admin" onSubmit={save}>
      <p>
        The audience numbers on <a href="/advertise">/advertise</a>. Type them as they should read; a group with no rows is hidden.
      </p>
      {GROUPS.map(([g, title, hint]) => (
        <fieldset key={g}>
          <legend>{title}</legend>
          <small>{hint}</small>
          {s[g].map((n, i) => (
            <div className="adv-admin-row" key={i}>
              <input aria-label="Number" placeholder="6M+" maxLength={AD_LIMITS.value} value={n.value} onChange={(e) => setRow(g, i, { value: e.target.value })} />
              <input aria-label="What it counts" placeholder="views in the last 28 days" maxLength={AD_LIMITS.label} value={n.label} onChange={(e) => setRow(g, i, { label: e.target.value })} />
              <button type="button" className="link" onClick={() => edit({ ...s, [g]: s[g].filter((_, k) => k !== i) })}>
                Remove
              </button>
            </div>
          ))}
          {s[g].length < AD_LIMITS.numbers && (
            <button type="button" className="btn btn-sm" onClick={() => edit({ ...s, [g]: [...s[g], { value: "", label: "" }] })}>
              Add a number
            </button>
          )}
        </fieldset>
      ))}
      <div className="adv-admin-pair">
        <label className="rp-field">
          <span>Checked <small>e.g. November 2026</small></span>
          <input maxLength={AD_LIMITS.text} value={s.updated ?? ""} onChange={(e) => edit({ ...s, updated: e.target.value })} />
        </label>
        <label className="rp-field">
          <span>Next open month <small>empty hides it</small></span>
          <input maxLength={AD_LIMITS.text} value={s.nextOpen ?? ""} onChange={(e) => edit({ ...s, nextOpen: e.target.value })} />
        </label>
      </div>
      <p className="adv-admin-save">
        <button type="submit" className="btn btn-go" disabled={state === "saving"}>
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        {state === "saved" && <span role="status">Saved. /advertise shows it now.</span>}
        {error && <span role="alert">{error}</span>}
      </p>
    </form>
  );
}

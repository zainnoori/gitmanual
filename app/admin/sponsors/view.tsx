"use client";

import { useEffect, useState } from "react";
import type { Sponsor } from "@/lib/db";
import { SPONSOR_IMAGE_TYPES, SPONSOR_LIMITS, today } from "@/lib/sponsor";

type Draft = { id: number | null; name: string; text: string; url: string; package: "shared" | "exclusive"; startsOn: string; endsOn: string; image?: string | null };

const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * 864e5).toISOString().slice(0, 10);
const blank = (): Draft => ({ id: null, name: "", text: "", url: "https://", package: "shared", startsOn: today(), endsOn: plusDays(today(), 29), image: undefined });
const status = (s: Sponsor, day = today()) => (s.endsOn < day ? "Ended" : s.startsOn > day ? "Booked" : "Running");
const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function SponsorsAdmin() {
  const [list, setList] = useState<Sponsor[] | null>(null);
  const [error, setError] = useState<"denied" | string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState<number | null>(null); // the booking whose Delete was pressed once

  const load = () =>
    fetch("/api/admin/sponsors", { cache: "no-store" }).then(async (r) => {
      if (r.status === 403) return setError("denied");
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return setError(j.error ?? "Couldn't load.");
      setList(j.sponsors);
    });
  useEffect(() => {
    load();
  }, []);

  if (error === "denied")
    return (
      <p>
        Admins only. <a href="/api/github/connect?signin=1&back=/admin/sponsors">Sign in with GitHub</a> with an account listed in <code>ADMIN_GITHUB_LOGINS</code>.
      </p>
    );
  if (error) return <p role="alert">{error}</p>;
  if (!list) return <p>Loading…</p>;

  const pick = (file: File | undefined) => {
    if (!file || !draft) return;
    if (!SPONSOR_IMAGE_TYPES.includes(file.type)) return setProblem("Use a PNG, JPEG or WebP picture.");
    if (file.size > SPONSOR_LIMITS.imageBytes) return setProblem(`That picture is ${Math.round(file.size / 1000)} KB: keep it under ${SPONSOR_LIMITS.imageBytes / 1000} KB.`);
    setProblem(null);
    const reader = new FileReader();
    reader.onload = () => setDraft((d) => d && { ...d, image: String(reader.result) });
    reader.readAsDataURL(file);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft) return;
    setBusy(true);
    setProblem(null);
    const r = await fetch("/api/admin/sponsors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft) });
    const j = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) return setProblem(j.error ?? "Couldn't save.");
    setDraft(null);
    load();
  }

  async function remove(id: number) {
    if (sure !== id) return setSure(id);
    setSure(null);
    const r = await fetch(`/api/admin/sponsors?id=${id}`, { method: "DELETE" });
    if (!r.ok) setError("Couldn't delete it.");
    load();
  }

  const preview = draft?.image ?? (draft?.id ? list.find((s) => s.id === draft.id && s.hasImage) && `/api/sponsor/image/${draft.id}?v=${list.find((s) => s.id === draft.id)?.updatedAt}` : null);

  return (
    <>
      <p>
        While a booking runs, its ad shows in the ad slot on manual pages, the shelf, lists and developer pages. <b>Exclusive</b> replaces Carbon;{" "}
        <b>Shared</b> takes turns with it (about half the page views each). Dates are whole days in UTC; one booking runs at a time, and Carbon
        comes back by itself when it ends. Clicks are counted without cookies; bots aren&apos;t counted.
      </p>

      {!draft && (
        <p>
          <button type="button" className="btn btn-go" onClick={() => setDraft(blank())}>
            Book a sponsor
          </button>
        </p>
      )}

      {draft && (
        <form className="sp-form" onSubmit={save}>
          <h2>{draft.id ? "Change the booking" : "New booking"}</h2>
          <div className="sp-grid">
            <label className="rp-field">
              <span>Sponsor</span>
              <input required maxLength={SPONSOR_LIMITS.name} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme" />
            </label>
            <label className="rp-field">
              <span>Package</span>
              <select value={draft.package} onChange={(e) => setDraft({ ...draft, package: e.target.value === "exclusive" ? "exclusive" : "shared" })}>
                <option value="shared">Shared: takes turns with Carbon</option>
                <option value="exclusive">Exclusive: the only ad</option>
              </select>
            </label>
            <label className="rp-field sp-wide">
              <span>
                One line <small>{draft.text.length}/{SPONSOR_LIMITS.text}</small>
              </span>
              <input required maxLength={SPONSOR_LIMITS.text} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} placeholder="Deploy any repo in one click. Free for open source." />
            </label>
            <label className="rp-field sp-wide">
              <span>
                Link <small>with their UTM tags</small>
              </span>
              <input required type="url" maxLength={SPONSOR_LIMITS.url} value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} spellCheck={false} />
            </label>
            <label className="rp-field">
              <span>First day</span>
              <input required type="date" value={draft.startsOn} onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })} />
            </label>
            <label className="rp-field">
              <span>Last day</span>
              <input required type="date" value={draft.endsOn} min={draft.startsOn} onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })} />
            </label>
            <div className="rp-field sp-wide">
              <span>
                Picture <small>PNG, JPEG or WebP, under {SPONSOR_LIMITS.imageBytes / 1000} KB, landscape (about 3:2, e.g. 600×400)</small>
              </span>
              <div className="sp-pic">
                {preview ? <img src={preview} alt="" /> : <span className="sp-pic-none">No picture yet</span>}
                <input type="file" accept={SPONSOR_IMAGE_TYPES.join(",")} onChange={(e) => pick(e.target.files?.[0])} />
              </div>
            </div>
          </div>
          {problem && <p role="alert" className="sp-problem">{problem}</p>}
          <p className="sp-actions">
            <button type="submit" className="btn btn-go" disabled={busy}>
              {busy ? "Saving…" : draft.id ? "Save changes" : "Book it"}
            </button>
            <button type="button" className="btn" onClick={() => (setDraft(null), setProblem(null))}>
              Cancel
            </button>
          </p>
        </form>
      )}

      <h2>Bookings</h2>
      {list.length === 0 ? (
        <p>None yet: the ad slot shows Carbon.</p>
      ) : (
        <div className="doc-table-wrap">
          <table className="doc-table">
            <thead>
              <tr>
                <th scope="col">Sponsor</th>
                <th scope="col">Package</th>
                <th scope="col">Dates (UTC)</th>
                <th scope="col">State</th>
                <th scope="col">Clicks</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <th scope="row">
                    {s.name}
                    <small className="sp-line">{s.text}</small>
                  </th>
                  <td>{s.package === "exclusive" ? "Exclusive" : "Shared"}</td>
                  <td>
                    {fmt(s.startsOn)} to {fmt(s.endsOn)}
                  </td>
                  <td>
                    <span className={`sp-state sp-${status(s).toLowerCase()}`}>{status(s)}</span>
                  </td>
                  <td className="num">{s.clicks.toLocaleString()}</td>
                  <td className="sp-row-actions">
                    <button type="button" className="link" onClick={() => setDraft({ id: s.id, name: s.name, text: s.text, url: s.url, package: s.package, startsOn: s.startsOn, endsOn: s.endsOn, image: undefined })}>
                      Change
                    </button>
                    <button type="button" className="link" onClick={() => remove(s.id)} onBlur={() => setSure(null)}>
                      {sure === s.id ? "Sure? Delete" : "Delete"}
                    </button>
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

"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedCard, SaveStatus } from "@/lib/db";
import { compactCount } from "@/lib/format";
import { OS_LABEL, OS_LIST, OS_SLUG, type OS } from "@/lib/os";
import { GitHubMark } from "../../github-mark";
import { Wrenches } from "../../ui";

// /profile/saved as a table you manage: search, filter by status, sort, change one or many, remove with undo.
// Built to take more columns and bulk actions later (grades, notes, export, alerts) without a redesign.

const STATUS: Record<SaveStatus, string> = { try: "To try", installed: "Installed", dropped: "Dropped" };
const STATUSES = Object.keys(STATUS) as SaveStatus[];
const LEVEL: Record<string, number> = { Easy: 1, Moderate: 2, Involved: 3 };

type Data = { login: string | null; saves?: SavedCard[]; error?: string };
type Sort = { by: "name" | "status" | "stars" | "saved"; desc: boolean };
type Undo = { saves: SavedCard[]; timer: ReturnType<typeof setTimeout> };

const nameOf = (s: SavedCard) => s.card?.fullName ?? s.key;
const isNew = (s: SavedCard) => Boolean(s.latestTag && s.latestTag !== s.releaseTag);

function ago(ms: number) {
  const days = Math.floor((Date.now() - ms) / 864e5);
  if (days < 1) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: days > 330 ? "numeric" : undefined });
}

async function send(method: "POST" | "DELETE", body: object) {
  const r = await fetch("/api/saved", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!r?.ok) throw new Error(j.error ?? "Couldn't change that right now. Try again in a moment.");
  return j;
}

// The server takes up to 100 repos per call; the table can select up to 500, so bigger actions go in groups.
const BATCH = 100;
async function sendAll<T>(method: "POST" | "DELETE", items: T[], body: (part: T[]) => object) {
  for (let i = 0; i < items.length; i += BATCH) await send(method, body(items.slice(i, i + BATCH)));
}

export function SavedList() {
  const [data, setData] = useState<Data | null>(null);
  const [filter, setFilter] = useState<SaveStatus | "all">("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({ by: "saved", desc: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/saved", { cache: "no-store" })
      .then(async (r) => ({ ...(await r.json()), ok: r.ok }))
      .then((j: Data & { ok: boolean }) => {
        setData(j.ok ? j : { login: null, error: j.error ?? "Your saved list isn't reachable right now." });
      })
      .catch(() => setData({ login: null, error: "Your saved list isn't reachable right now." }));
  }, []);

  // Row menus (<details>) close when you click anywhere else.
  useEffect(() => {
    const close = (e: MouseEvent) =>
      document.querySelectorAll<HTMLDetailsElement>("details.row-menu[open]").forEach((d) => !d.contains(e.target as Node) && (d.open = false));
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const saves = useMemo(() => data?.saves ?? [], [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = saves.filter(
      (s) => (filter === "all" || s.status === filter) && (!q || nameOf(s).toLowerCase().includes(q) || (s.card?.description ?? "").toLowerCase().includes(q)),
    );
    const value = (s: SavedCard): string | number =>
      sort.by === "name" ? nameOf(s).toLowerCase() : sort.by === "status" ? STATUSES.indexOf(s.status) : sort.by === "stars" ? (s.card?.stars ?? -1) : s.savedAt;
    return rows.sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
    });
  }, [saves, filter, query, sort]);

  // Selection follows what's on screen: rows hidden by a filter or search aren't acted on.
  const picked = shown.filter((s) => selected.has(s.key));
  const allPicked = shown.length > 0 && picked.length === shown.length;

  const patch = (keys: string[], fn: (s: SavedCard) => SavedCard | null) =>
    setData((d) => (d?.saves ? { ...d, saves: d.saves.map((s) => (keys.includes(s.key) ? fn(s) : s)).filter((s): s is SavedCard => s !== null) } : d));

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (rows: SavedCard[], status: SaveStatus) =>
    run(async () => {
      const keys = rows.map((s) => s.key);
      if (rows.length === 1) await send("POST", { repo: keys[0], os: rows[0].os, status });
      else await sendAll("POST", keys, (repos) => ({ repos, status }));
      patch(keys, (s) => ({ ...s, status, updatedAt: Date.now() }));
    });

  const setOs = (row: SavedCard, os: OS) =>
    run(async () => {
      await send("POST", { repo: row.key, os, status: row.status });
      patch([row.key], (s) => ({ ...s, os }));
    });

  const seen = (rows: SavedCard[]) =>
    run(async () => {
      const keys = rows.map((s) => s.key);
      await sendAll("POST", keys, (repos) => ({ repos, seen: true }));
      patch(keys, (s) => ({ ...s, releaseTag: s.latestTag }));
    });

  const remove = (rows: SavedCard[]) =>
    run(async () => {
      const keys = rows.map((s) => s.key);
      await sendAll("DELETE", keys, (repos) => ({ repos }));
      patch(keys, () => null);
      setSelected((sel) => new Set([...sel].filter((k) => !keys.includes(k))));
      if (undo) clearTimeout(undo.timer);
      setUndo({ saves: rows, timer: setTimeout(() => setUndo(null), 8000) });
    });

  const restore = () =>
    undo &&
    run(async () => {
      clearTimeout(undo.timer);
      const all = undo.saves.map(({ key, os, status, savedAt, updatedAt, releaseTag }) => ({ key, os, status, savedAt, updatedAt, releaseTag }));
      await sendAll("POST", all, (restore) => ({ restore }));
      setData((d) => (d ? { ...d, saves: [...(d.saves ?? []), ...undo.saves] } : d));
      setUndo(null);
    });

  const toggle = (key: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!data) return <p className="note saved-loading">Loading your saved repos…</p>;
  if (data.error) return <p className="panel">{data.error}</p>;
  if (!data.login)
    return (
      <div className="panel saved-empty">
        <h2>Sign in to see your saved repos</h2>
        <p className="note">Press Save on any manual to keep it here, with whether you&apos;ve tried it yet.</p>
        <a className="btn btn-go" href={`/api/github/connect?signin=1&back=${encodeURIComponent("/profile/saved")}`}>
          <GitHubMark /> Sign in with GitHub
        </a>
      </div>
    );
  if (!saves.length && !undo)
    return (
      <div className="panel saved-empty">
        <h2>Nothing saved yet</h2>
        <p className="note">Press Save on any manual, next to &ldquo;Download PDF manual&rdquo;, and it shows up here.</p>
        <Link className="btn btn-go" href="/shelf">
          Browse the shelf
        </Link>
      </div>
    );

  const count = (s: SaveStatus) => saves.filter((x) => x.status === s).length;
  const head = (by: Sort["by"], label: string, className?: string) => (
    <th scope="col" className={className} aria-sort={sort.by === by ? (sort.desc ? "descending" : "ascending") : undefined}>
      <button type="button" className="th-sort" onClick={() => setSort((s) => ({ by, desc: s.by === by ? !s.desc : by === "stars" || by === "saved" }))}>
        {label}
        <span className="th-arrow" aria-hidden="true">
          {sort.by === by ? (sort.desc ? "↓" : "↑") : "↕"}
        </span>
      </button>
    </th>
  );

  return (
    <div className="saved-dash">
      <div className="saved-bar">
        <label className="saved-search">
          <span className="sr-only">Filter saved repos</span>
          <input type="search" value={query} placeholder="Filter saved repos…" autoComplete="off" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <nav className="view-switch saved-filter" aria-label="Show">
          {(["all", ...STATUSES] as const).map((f) => (
            <button key={f} type="button" aria-current={filter === f ? "page" : undefined} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : STATUS[f]} <span className="count">{f === "all" ? saves.length : count(f)}</span>
            </button>
          ))}
        </nav>
        <p className="saved-who note">
          @{data.login} · {saves.length} saved
        </p>
      </div>

      {picked.length > 0 && (
        <div className="bulk-bar" role="region" aria-label="Selected repos">
          <b>{picked.length} selected</b>
          <label>
            <span className="sr-only">Set status of the selected repos</span>
            <select value="" disabled={busy} onChange={(e) => e.target.value && setStatus(picked, e.target.value as SaveStatus)}>
              <option value="">Set status…</option>
              {STATUSES.map((k) => (
                <option key={k} value={k}>
                  {STATUS[k]}
                </option>
              ))}
            </select>
          </label>
          {picked.some(isNew) && (
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => seen(picked.filter(isNew))}>
              Mark releases seen
            </button>
          )}
          <button type="button" className="btn btn-sm bulk-remove" disabled={busy} onClick={() => remove(picked)}>
            Remove
          </button>
          <button type="button" className="link" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {error && (
        <p className="save-error" role="alert">
          {error}
        </p>
      )}

      {shown.length ? (
        <div className="saved-table-wrap">
          <table className="saved-table">
            <thead>
              <tr>
                <th scope="col" className="col-check">
                  <input
                    type="checkbox"
                    aria-label={allPicked ? "Unselect all" : "Select all shown"}
                    checked={allPicked}
                    ref={(el) => {
                      if (el) el.indeterminate = picked.length > 0 && !allPicked;
                    }}
                    onChange={() => setSelected(allPicked ? new Set() : new Set(shown.map((s) => s.key)))}
                  />
                </th>
                {head("name", "Repo", "col-repo")}
                {head("status", "Status")}
                <th scope="col">Computer</th>
                <th scope="col">Latest release</th>
                {head("stars", "Stars", "col-num")}
                <th scope="col">Difficulty</th>
                {head("saved", "Saved")}
                <th scope="col" className="col-menu">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Row
                  key={s.key}
                  save={s}
                  checked={selected.has(s.key)}
                  busy={busy}
                  onCheck={() => toggle(s.key)}
                  onStatus={(st) => setStatus([s], st)}
                  onOs={(os) => setOs(s, os)}
                  onSeen={() => seen([s])}
                  onRemove={() => remove([s])}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="panel note">{query ? `No saved repo matches “${query}”.` : "Nothing with this status. Change a repo's status to put it here."}</p>
      )}

      {undo && (
        <div className="undo-toast" role="status">
          Removed {undo.saves.length === 1 ? nameOf(undo.saves[0]) : `${undo.saves.length} repos`}.
          <button type="button" className="link" onClick={restore} disabled={busy}>
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

function Row({
  save: s,
  checked,
  busy,
  onCheck,
  onStatus,
  onOs,
  onSeen,
  onRemove,
}: {
  save: SavedCard;
  checked: boolean;
  busy: boolean;
  onCheck: () => void;
  onStatus: (s: SaveStatus) => void;
  onOs: (os: OS) => void;
  onSeen: () => void;
  onRemove: () => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // The menu is placed against the window (position: fixed), so the table's scrolling box can't cut it off. It opens
  // below the ⋯ button, or above it when there isn't room, and follows the button when the page scrolls or resizes.
  const place = () => {
    const d = menu.current;
    const l = list.current;
    if (!d?.open || !l) return;
    const b = d.querySelector("summary")!.getBoundingClientRect();
    const h = l.offsetHeight;
    const below = b.bottom + 6 + h <= window.innerHeight - 8;
    l.style.top = `${below ? b.bottom + 6 : Math.max(8, b.top - 6 - h)}px`;
    l.style.left = `${Math.max(8, Math.min(b.right - l.offsetWidth, window.innerWidth - l.offsetWidth - 8))}px`;
  };
  useEffect(() => {
    const follow = () => place();
    window.addEventListener("scroll", follow, { passive: true, capture: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- place only reads refs
  }, []);
  const name = nameOf(s);
  const os = s.os as OS;
  const manual = `/${name}/${OS_SLUG[os] ?? ""}`;
  const fresh = isNew(s);
  const level = s.card ? (LEVEL[s.card.difficulty] ?? 2) : 0;
  const act = (fn: () => void) => () => {
    if (menu.current) menu.current.open = false;
    fn();
  };
  return (
    <tr className={checked ? "picked" : undefined}>
      <td className="col-check">
        <input type="checkbox" aria-label={`Select ${name}`} checked={checked} onChange={onCheck} />
      </td>
      <td className="col-repo">
        <Link href={manual} className="saved-name" translate="no">
          <span className="owner">{name.split("/")[0]}/</span>
          {name.split("/")[1]}
        </Link>
        {s.card?.description && <span className="saved-desc">{s.card.description.replace(/:[a-z0-9_+-]+:\s*/g, "")}</span>}
      </td>
      <td data-label="Status">
        <select className={`status-pill st-${s.status}`} value={s.status} disabled={busy} aria-label={`Status of ${name}`} onChange={(e) => onStatus(e.target.value as SaveStatus)}>
          {STATUSES.map((k) => (
            <option key={k} value={k}>
              {STATUS[k]}
            </option>
          ))}
        </select>
      </td>
      <td data-label="Computer">
        <select className="os-select" value={os} disabled={busy} aria-label={`Computer for ${name}`} onChange={(e) => onOs(e.target.value as OS)}>
          {OS_LIST.map((o) => (
            <option key={o} value={o}>
              {OS_LABEL[o]}
            </option>
          ))}
        </select>
      </td>
      <td data-label="Latest release" className="col-release">
        {s.latestTag ? (
          <span className={fresh ? "rel rel-new" : "rel"} title={fresh ? `New since you saved it (you saved it at ${s.releaseTag ?? "no release"})` : undefined}>
            {fresh && <span className="rel-dot" aria-hidden="true" />}
            <code>{s.latestTag}</code>
            {fresh && <span className="sr-only"> (new since you saved it)</span>}
          </span>
        ) : (
          <span className="muted">None</span>
        )}
      </td>
      <td data-label="Stars" className="col-num num">
        {s.card ? `★ ${compactCount(s.card.stars)}` : "–"}
      </td>
      <td data-label="Difficulty">
        {s.card ? (
          <span className="saved-level">
            <Wrenches n={level} /> {s.card.difficulty}
          </span>
        ) : (
          "–"
        )}
      </td>
      <td data-label="Saved" className="col-date" title={new Date(s.savedAt).toLocaleString()}>
        {ago(s.savedAt)}
      </td>
      <td className="col-menu">
        <details className="row-menu" ref={menu} onToggle={place}>
          <summary aria-label={`Actions for ${name}`}>⋯</summary>
          <div className="row-menu-list" role="menu" ref={list}>
            <Link role="menuitem" href={manual}>
              Open manual
            </Link>
            <a role="menuitem" href={`https://github.com/${name}`} target="_blank" rel="noreferrer">
              Open on GitHub ↗
            </a>
            {fresh && (
              <button type="button" role="menuitem" onClick={act(onSeen)}>
                Mark release as seen
              </button>
            )}
            <button type="button" role="menuitem" className="danger" onClick={act(onRemove)}>
              Remove
            </button>
          </div>
        </details>
      </td>
    </tr>
  );
}

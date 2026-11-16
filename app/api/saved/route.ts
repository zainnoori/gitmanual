import { NextResponse } from "next/server";
import { ackRelease, deleteSave, getSave, listSaves, MAX_SAVES, putSave, repoKey, restoreSaves, SAVE_STATUSES, type Save, type SaveStatus } from "@/lib/db";
import { parseRepoUrl } from "@/lib/github";
import { limit, LimitError, limitHeaders } from "@/lib/limit";
import { OS_LIST, type OS } from "@/lib/os";
import { viewer } from "@/lib/viewer";

// Saved repos for the signed-in person (/profile/saved and the Save button on a manual).
//   GET ?repo=owner/name                  → { login, save }: whether this repo is saved
//   GET                                   → { login, saves }: the whole list, with each repo's card
//   POST { repo, os, status? }            → save it, or change its status / computer
//   POST { repos: [...], status }         → change the status of several (the table's bulk action)
//   POST { repo | repos, seen: true }     → "seen the new release"
//   POST { restore: [save, ...] }         → undo a remove: put them back exactly as they were
//   DELETE { repo } or { repos: [...] }   → remove
// Signed out, every call answers { login: null }. Public repos only: a branch or private repo can't be saved.
const NO_STORE = { "Cache-Control": "private, no-store" };
const MAX_BATCH = 100;

const keyOf = (repo: unknown) => {
  const ref = typeof repo === "string" ? parseRepoUrl(repo) : null;
  return ref && !ref.ref ? repoKey(ref.owner, ref.repo) : null;
};

// One repo or a list of them: their keys, or null when any is malformed.
const keysOf = (body: { repo?: unknown; repos?: unknown }): string[] | null => {
  const raw = Array.isArray(body.repos) ? body.repos : body.repo !== undefined ? [body.repo] : [];
  if (!raw.length || raw.length > MAX_BATCH) return null;
  const keys = raw.map(keyOf);
  return keys.every(Boolean) ? [...new Set(keys as string[])] : null;
};

const isSave = (x: unknown): x is Save => {
  const s = x as Save;
  return (
    Boolean(s) &&
    typeof s.key === "string" &&
    keyOf(s.key) === s.key &&
    OS_LIST.includes(s.os as OS) &&
    SAVE_STATUSES.includes(s.status) &&
    Number.isFinite(s.savedAt) &&
    Number.isFinite(s.updatedAt) &&
    (s.releaseTag === null || typeof s.releaseTag === "string")
  );
};

export async function GET(req: Request) {
  const { user, settle } = await viewer();
  if (!user) return settle(NextResponse.json({ login: null }, { headers: NO_STORE }));
  const repo = new URL(req.url).searchParams.get("repo");
  try {
    if (repo) {
      const key = keyOf(repo);
      if (!key) return NextResponse.json({ error: "Expected ?repo=owner/name" }, { status: 400, headers: NO_STORE });
      return settle(NextResponse.json({ login: user.login, save: await getSave(user.id, key) }, { headers: NO_STORE }));
    }
    return settle(NextResponse.json({ login: user.login, saves: await listSaves(user.id), max: MAX_SAVES }, { headers: NO_STORE }));
  } catch {
    return NextResponse.json({ error: "Your saved list isn't reachable right now." }, { status: 503, headers: NO_STORE });
  }
}

type Body = { repo?: string; repos?: string[]; os?: OS; status?: SaveStatus; seen?: boolean; restore?: unknown[] };

async function change(req: Request, remove: boolean) {
  const { user, settle } = await viewer();
  if (!user) return settle(NextResponse.json({ login: null, error: "Sign in with GitHub to save repos." }, { status: 401, headers: NO_STORE }));
  const body = (await req.json().catch(() => ({}))) as Body;
  const bad = (error: string) => NextResponse.json({ error }, { status: 400, headers: NO_STORE });
  try {
    await limit("save", `u:${user.id}`);
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: e.message }, { status: 429, headers: { ...NO_STORE, ...limitHeaders(e) } });
    throw e;
  }
  const ok = (extra: object) => settle(NextResponse.json({ login: user.login, ...extra }, { headers: NO_STORE }));
  try {
    if (body.restore) {
      if (!Array.isArray(body.restore) || !body.restore.length || body.restore.length > MAX_BATCH || !body.restore.every(isSave))
        return bad("Expected { restore: [saves] }");
      if (!(await restoreSaves(user.id, body.restore as Save[])))
        return NextResponse.json({ error: `Your saved list is full (${MAX_SAVES} repos). Remove some to put these back.` }, { status: 409, headers: NO_STORE });
      return ok({ restored: body.restore.length });
    }
    const keys = keysOf(body);
    if (!keys) return bad(`Expected { repo: owner/name } or { repos: [...] } (up to ${MAX_BATCH})`);
    if (remove) {
      for (const k of keys) await deleteSave(user.id, k);
      return ok({ save: null, removed: keys.length });
    }
    if (body.seen) {
      for (const k of keys) await ackRelease(user.id, k);
      return ok({ save: keys.length === 1 ? await getSave(user.id, keys[0]) : undefined });
    }
    const status = body.status ?? "try";
    if (!SAVE_STATUSES.includes(status)) return bad("Expected status: try, installed or dropped");
    // Several at once: a status change on repos already saved (each keeps its computer).
    if (Array.isArray(body.repos)) {
      const saves = [];
      for (const k of keys) {
        const had = await getSave(user.id, k);
        if (had) saves.push(await putSave(user.id, k, had.os, status));
      }
      return ok({ saves });
    }
    const os = body.os && OS_LIST.includes(body.os) ? body.os : null;
    if (!os) return bad("Expected { repo, os, status? }");
    const save = await putSave(user.id, keys[0], os, status);
    if (!save) return NextResponse.json({ error: `Your saved list is full (${MAX_SAVES} repos). Remove some to save more.` }, { status: 409, headers: NO_STORE });
    return ok({ save });
  } catch {
    return NextResponse.json({ error: "Couldn't save that right now. Try again in a moment." }, { status: 503, headers: NO_STORE });
  }
}

export const POST = (req: Request) => change(req, false);
export const DELETE = (req: Request) => change(req, true);

import { NextResponse } from "next/server";
import { goneRepos, hideRepo, repoKey, unhideRepo } from "@/lib/db";
import { parseRepoUrl } from "@/lib/github";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): manuals taken down, and repos a re-read found gone from GitHub (app/admin/repos).
//   GET  → { repos: GoneRepo[] }
//   POST { repo, action: "hide" | "unhide", note? } → { ok: true }
const NO_STORE = { "Cache-Control": "private, no-store" };

async function admin() {
  const { user } = await viewer();
  return user && isAdmin(user.login) ? user : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json({ repos: await goneRepos() }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

export async function POST(req: Request) {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const b = (await req.json().catch(() => null)) as { repo?: unknown; action?: unknown; note?: unknown } | null;
  const ref = typeof b?.repo === "string" ? parseRepoUrl(b.repo) : null;
  if (!ref) return NextResponse.json({ error: "Paste a repo like owner/name or its GitHub link." }, { status: 400, headers: NO_STORE });
  if (b?.action !== "hide" && b?.action !== "unhide") return NextResponse.json({ error: "Pick hide or unhide." }, { status: 400, headers: NO_STORE });
  const key = repoKey(ref.owner, ref.repo);
  const note = typeof b.note === "string" ? b.note.replace(/[\r\n]+/g, " ").trim() : "";
  try {
    if (b.action === "hide") await hideRepo(key, `${ref.owner}/${ref.repo}`, note || null, user.login);
    else await unhideRepo(key);
    return NextResponse.json({ ok: true }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

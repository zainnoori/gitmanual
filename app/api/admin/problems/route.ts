import { NextResponse } from "next/server";
import { listProblems, setProblemStatus, type ProblemStatus } from "@/lib/db";
import { loadRepo, VERSION } from "@/lib/pipeline";
import { isAdmin, viewer } from "@/lib/viewer";

export const maxDuration = 120;

// For site admins (ADMIN_GITHUB_LOGINS): problem reports from the manuals (/admin/problems), and marking them fixed.
const NO_STORE = { "Cache-Control": "private, no-store" };
const STATUSES: ProblemStatus[] = ["open", "fixed", "closed"];

async function admin() {
  const { user } = await viewer();
  return user && isAdmin(user.login) ? user : null;
}

export async function GET(req: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const s = new URL(req.url).searchParams.get("status");
  const status = s === "all" || STATUSES.includes(s as ProblemStatus) ? (s as ProblemStatus | "all") : "open";
  return NextResponse.json({ problems: await listProblems(status) }, { headers: NO_STORE });
}

// {id, status} marks a report; {rebuild: "owner/Name"} reads that repo from GitHub again and saves the new manual,
// to check a fix before replying.
export async function POST(req: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const body = (await req.json().catch(() => ({}))) as { id?: number; status?: ProblemStatus; rebuild?: string };
  if (typeof body.rebuild === "string") {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([\w.-]+)$/.exec(body.rebuild.trim());
    if (!m || m[2] === "." || m[2] === "..") return NextResponse.json({ error: "That isn't owner/repo." }, { status: 400, headers: NO_STORE });
    try {
      const loaded = await loadRepo({ owner: m[1], repo: m[2] }, { fresh: true });
      if (loaded.gone)
        return NextResponse.json(
          { error: "GitHub says this repo is gone (deleted, private, or its owner's account removed). It's off the shelf now; see Repos to take it down." },
          { status: 502, headers: NO_STORE },
        );
      return NextResponse.json({ ok: true, version: VERSION, analyzedAt: loaded.analyzedAt, saved: !loaded.cached }, { headers: NO_STORE });
    } catch (e) {
      return NextResponse.json({ error: `Couldn't rebuild it: ${e instanceof Error ? e.message : String(e)}` }, { status: 502, headers: NO_STORE });
    }
  }
  const { id, status } = body;
  if (typeof id !== "number" || !STATUSES.includes(status as ProblemStatus)) return NextResponse.json({ error: "Send id and status." }, { status: 400, headers: NO_STORE });
  await setProblemStatus(id, status!);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

import { NextResponse } from "next/server";
import { listProblems, setProblemStatus, type ProblemStatus } from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

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

export async function POST(req: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const { id, status } = (await req.json().catch(() => ({}))) as { id?: number; status?: ProblemStatus };
  if (typeof id !== "number" || !STATUSES.includes(status as ProblemStatus)) return NextResponse.json({ error: "Send id and status." }, { status: 400, headers: NO_STORE });
  await setProblemStatus(id, status!);
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

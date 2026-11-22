import { after, NextResponse } from "next/server";
import { saveProblem } from "@/lib/db";
import { limit, LimitError, limitHeaders, visitor } from "@/lib/limit";
import { notifyProblem } from "@/lib/notify";
import { checkProblem } from "@/lib/problems";
import { viewer } from "@/lib/viewer";

// Contact messages and problem reports (app/report-problem.tsx): one at a time, kept for /admin/problems.
//   POST {mode, kind, repo?, os?, step?, stepTitle?, name?, message, error?, email?, page?, version?, website} → {ok: true}
// `website` is a field people never see: a bot that fills it in gets a thank-you and nothing is kept.
const headers = { "Cache-Control": "private, no-store" };

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Expected a JSON report." }, { status: 400, headers });
  if (typeof body.website === "string" && body.website.trim()) return NextResponse.json({ ok: true }, { headers });
  const p = checkProblem(body);
  if (typeof p === "string") return NextResponse.json({ error: p }, { status: 400, headers });
  try {
    await limit("problem", visitor(req.headers));
  } catch (e) {
    if (e instanceof LimitError) return NextResponse.json({ error: e.message }, { status: 429, headers: { ...headers, ...limitHeaders(e) } });
    throw e;
  }
  const { user, settle } = await viewer();
  try {
    const githubLogin = user?.login ?? null;
    const id = await saveProblem({ ...p, githubLogin });
    // An email to the admins (ADMIN_EMAIL) once the visitor has their answer.
    after(() => notifyProblem({ ...p, id, githubLogin }));
  } catch (e) {
    console.error("gitmanual problem report:", e);
    return settle(NextResponse.json({ error: "Couldn't send it just now. Try again in a minute." }, { status: 503, headers }));
  }
  return settle(NextResponse.json({ ok: true }, { headers }));
}

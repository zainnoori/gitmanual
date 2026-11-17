import { NextResponse } from "next/server";
import { allowance } from "@/lib/budget";
import { countInterest } from "@/lib/db";
import { firstTime, visitor } from "@/lib/limit";
import { parseRepoUrl } from "@/lib/github";
import { inspect, InspectionError, saved } from "@/lib/inspection";
import { teaser } from "@/lib/inspection/labels";
import { isPro } from "@/lib/pro";
import { PRO_ENABLED } from "@/lib/stripe";
import { viewer } from "@/lib/viewer";

// Deep Inspection (Pro). Never cached by the CDN: the report is for Pro members only.
//   GET  ?repo=owner/name → { signedIn, login, pro, left, inspection | null, fresh } (the saved report, if any; nothing
//        is built). Without Pro: { ..., inspection: null, teaser } instead, the free preview of a saved report
//        (lib/inspection/labels.ts teaser: verdict, counts and the first finding; the rest stays on the server). &view=1 when the inspection page itself asks: a signed-in member without Pro then counts as
//        interest in Deep Inspection for that repo (once each), like the PDF download does.
//   POST { repo, rescan? } → { inspection, fresh } (builds one when there's no fresh report, or on rescan)
export const maxDuration = 90; // a new report reads GitHub and several other services, then asks Claude

const headers = { "Cache-Control": "private, no-store" };

async function who() {
  const { user, settle } = await viewer();
  const pro = user && PRO_ENABLED() ? await isPro(user.id) : false;
  return { user, pro, settle };
}

export async function GET(req: Request) {
  const ref = parseRepoUrl(new URL(req.url).searchParams.get("repo") ?? "");
  if (!ref) return NextResponse.json({ error: "Expected ?repo=owner/name" }, { status: 400, headers });
  const { user, pro, settle } = await who();
  if (!pro) {
    if (user && new URL(req.url).searchParams.has("view") && PRO_ENABLED()) {
      const repo = `${ref.owner}/${ref.repo}`;
      if (await firstTime(`interest:inspection:${repo.toLowerCase()}`, visitor(req.headers))) await countInterest("inspection", repo);
    }
    const s = await saved(ref).catch(() => null);
    return settle(NextResponse.json({ signedIn: Boolean(user), login: user?.login ?? null, pro: false, inspection: null, teaser: s ? teaser(s.inspection) : null }, { headers }));
  }
  const [s, left] = await Promise.all([saved(ref), allowance("inspection", String(user!.id))]);
  return settle(NextResponse.json({ signedIn: true, pro: true, left: left ? left.limit - left.used : null, inspection: s?.inspection ?? null, fresh: s?.fresh ?? false }, { headers }));
}

export async function POST(req: Request) {
  const { repo, rescan } = (await req.json().catch(() => ({}))) as { repo?: string; rescan?: boolean };
  const ref = repo ? parseRepoUrl(repo) : null;
  if (!ref) return NextResponse.json({ error: "Expected { repo }" }, { status: 400, headers });
  const { user, pro, settle } = await who();
  if (!user) return settle(NextResponse.json({ error: "Sign in with GitHub to use Deep Inspection.", signIn: true }, { status: 401, headers }));
  if (!pro) return settle(NextResponse.json({ error: "Deep Inspection is part of GitManual Pro.", pro: false }, { status: 402, headers }));
  try {
    const r = await inspect(ref, String(user.id), { rescan: Boolean(rescan) });
    return settle(NextResponse.json(r, { headers }));
  } catch (e) {
    if (!(e instanceof InspectionError)) throw e;
    return settle(
      NextResponse.json({ error: e.message }, { status: e.status, headers: { ...headers, ...(e.retryAfter ? { "Retry-After": String(e.retryAfter) } : {}) } }),
    );
  }
}

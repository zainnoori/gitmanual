import { NextResponse } from "next/server";
import { sponsorClick, sponsorUrl } from "@/lib/db";

// A click on a sponsor's ad: counted, then sent on to the sponsor's link. Bots and link previews go through
// without being counted. No cookies, nothing about the visitor is kept: only the total.
const BOT = /bot|crawl|spider|slurp|preview|fetch|curl|wget|python|headless|facebookexternalhit|embedly|monitor/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return NextResponse.redirect(new URL("/", req.url));
  const ua = req.headers.get("user-agent") ?? "";
  const url = !ua || BOT.test(ua) || req.headers.get("purpose") === "prefetch" ? await sponsorUrl(id) : await sponsorClick(id);
  return NextResponse.redirect(url ?? new URL("/", req.url), { status: 302, headers: { "Cache-Control": "no-store", "Referrer-Policy": "origin" } });
}

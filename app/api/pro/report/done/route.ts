import { NextResponse } from "next/server";
import { syncReportCheckout } from "@/lib/pro";
import { sitePath } from "@/lib/site";
import { PRO_ENABLED } from "@/lib/stripe";
import { viewer } from "@/lib/viewer";

// Back from a repo-report checkout: records the payment right away (the webhook does too, in case this page is
// never reached), then goes on to the report with ?bought=1. If it can't be confirmed yet (not paid yet, signed out,
// or the database refused), ?bought=pending: the page says so instead of offering to pay again. Under /api so the
// GitHub sign-in cookie comes along.
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const back = sitePath(q.get("back")) ?? "/profile/reports";
  const to = (bought: "1" | "pending" | null) => {
    const u = new URL(back, req.url); // keeps a #pdf on the end, after ?bought=1
    if (bought) u.searchParams.set("bought", bought);
    return NextResponse.redirect(u);
  };
  const session = q.get("session_id");
  if (!PRO_ENABLED() || !session || !/^cs_[\w]+$/.test(session)) return to(null);
  const { user, settle } = await viewer();
  if (!user) return to("pending");
  try {
    const p = await syncReportCheckout(session, user.id);
    return settle(to(p ? "1" : "pending"));
  } catch (e) {
    console.error("gitmanual report checkout return:", e);
    return settle(to("pending"));
  }
}

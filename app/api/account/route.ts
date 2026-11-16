import { NextResponse } from "next/server";
import { proFor } from "@/lib/pro";
import { PRO_ENABLED } from "@/lib/stripe";
import { isAdmin, viewer } from "@/lib/viewer";

// For the header's account menu: who's signed in, and what to link to. Only asked when the page sees the "signed in"
// hint cookie (lib/site.ts SIGNED_IN_COOKIE); signed out it answers { login: null } and clears that hint.
export async function GET() {
  const headers = { "Cache-Control": "private, no-store" };
  const { user, settle } = await viewer();
  if (!user) return settle(NextResponse.json({ login: null }, { headers }));
  const pro = PRO_ENABLED() ? (await proFor(user.id).catch(() => ({ pro: false }))).pro : false;
  return settle(NextResponse.json({ login: user.login, id: user.id, pro, proEnabled: PRO_ENABLED(), admin: isAdmin(user.login) }, { headers }));
}

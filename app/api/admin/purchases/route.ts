import { NextResponse } from "next/server";
import { listPayments } from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): every one-time repo purchase and every Pro subscription.
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  const { user } = await viewer();
  if (!user || !isAdmin(user.login)) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  try {
    return NextResponse.json(await listPayments(), { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

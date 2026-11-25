import { NextResponse } from "next/server";
import { savedAdStats } from "@/lib/advertise-store";
import { adminOverview } from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): the numbers on /admin and the problems still waiting for an answer.
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET() {
  const { user } = await viewer();
  if (!user || !isAdmin(user.login)) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  try {
    const [overview, ads] = await Promise.all([adminOverview(), savedAdStats()]);
    return NextResponse.json({ ...overview, advertiseChecked: ads.updated, advertiseSite: ads.site.length }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

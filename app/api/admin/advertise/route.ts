import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";
import { saveAdStats, savedAdStats } from "@/lib/advertise-store";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): the audience numbers shown on /advertise, read and saved.
const NO_STORE = { "Cache-Control": "private, no-store" };

async function admin() {
  const { user } = await viewer();
  return user && isAdmin(user.login) ? user : null;
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  return NextResponse.json({ stats: await savedAdStats() }, { headers: NO_STORE });
}

export async function POST(req: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  try {
    const stats = await saveAdStats(await req.json().catch(() => ({})));
    revalidatePath("/advertise"); // the page shows the new numbers right away
    return NextResponse.json({ ok: true, stats }, { headers: NO_STORE });
  } catch (e) {
    return NextResponse.json({ error: `Couldn't save: ${e instanceof Error ? e.message : String(e)}` }, { status: 500, headers: NO_STORE });
  }
}

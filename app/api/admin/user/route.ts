import { NextResponse } from "next/server";
import {
  chatUsageFor,
  emailsAbout,
  githubIdForLogin,
  keyForUser,
  problemsByLogin,
  purchasesFor,
  subscriptionFor,
  userById,
  type EmailRef,
} from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): everything on one person (/admin/user?login= or ?id=): their sign-ins,
// purchases, Pro, chat, API key, the problems they reported while signed in and the emails sent to them.
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(req: Request) {
  const { user } = await viewer();
  if (!user || !isAdmin(user.login)) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const q = new URL(req.url).searchParams;
  try {
    const login = q.get("login")?.trim() ?? "";
    const id = /^\d{1,12}$/.test(q.get("id") ?? "") ? Number(q.get("id")) : login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? await githubIdForLogin(login) : null;
    if (!id) return NextResponse.json({ error: "No user with that GitHub username or id here." }, { status: 404, headers: NO_STORE });

    const [who, purchases, subscription, chat, key] = await Promise.all([userById(id), purchasesFor(id), subscriptionFor(id), chatUsageFor(id), keyForUser(id)]);
    if (!who && !purchases.length && !subscription) return NextResponse.json({ error: "No user with that GitHub id here." }, { status: 404, headers: NO_STORE });
    const name = who?.login ?? key?.login ?? null;
    const problems = name ? await problemsByLogin(name) : [];
    const refs: EmailRef[] = [
      ...purchases.map((p) => ({ kind: "purchase" as const, id: p.session })),
      ...(subscription ? [{ kind: "subscription" as const, id: subscription.subscription }] : []),
      ...problems.map((p) => ({ kind: "problem" as const, id: String(p.id) })),
    ];
    const emails = await emailsAbout(refs);
    return NextResponse.json({ user: { ...who, githubId: id, login: name }, purchases, subscription, chat, key, problems, emails }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

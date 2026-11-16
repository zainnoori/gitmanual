import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { cookieOptions, fresh, githubApp, hintOptions, open, seal, SESSION_COOKIE } from "./session";
import { SIGNED_IN_COOKIE } from "./site";

// The visitor's GitHub sign-in (the encrypted cookie from lib/session.ts), checked with GitHub: who they are and
// the token to act for them. `settle` writes back a renewed sign-in, or forgets one GitHub no longer accepts.
export type Viewer = { id: number; login: string; token: string };

export async function viewer(): Promise<{ user: Viewer | null; settle: (res: NextResponse) => NextResponse }> {
  const app = githubApp();
  const jar = await cookies();
  const session = app ? open(jar.get(SESSION_COOKIE)?.value) : null;
  const hinted = jar.has(SIGNED_IN_COOKIE);
  const connected = app && session ? await fresh(app, session) : null;
  // Signed out, but the page still thinks otherwise: drop the hint so the header stops asking.
  if (!connected) return { user: null, settle: (res) => (hinted && res.cookies.delete({ name: SIGNED_IN_COOKIE, path: "/" }), res) };

  const res = await fetch("https://api.github.com/user", {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "gitmanual", Authorization: `Bearer ${connected.session.token}` },
    cache: "no-store",
  }).catch(() => null);
  const u = res?.ok ? ((await res.json()) as { id: number; login: string }) : null;
  const settle = (out: NextResponse) => {
    if (!u && res?.status === 401) {
      out.cookies.delete({ name: SESSION_COOKIE, path: "/api" });
      out.cookies.delete({ name: SIGNED_IN_COOKIE, path: "/" });
    } else {
      if (connected.renewed) out.cookies.set(SESSION_COOKIE, seal(connected.session), cookieOptions());
      // Signed in from before the hint existed: add it, so the header shows the account menu.
      if (u && !hinted) out.cookies.set(SIGNED_IN_COOKIE, "1", hintOptions());
    }
    return out;
  };
  return { user: u ? { id: u.id, login: u.login, token: connected.session.token } : null, settle };
}

// Site admins (the API key list), by GitHub username: ADMIN_GITHUB_LOGINS=you,teammate
export const isAdmin = (login: string) =>
  (process.env.ADMIN_GITHUB_LOGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());

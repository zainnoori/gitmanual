import { NextResponse } from "next/server";
import { dbPing, healthMarks } from "@/lib/db";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): is each part set up, and when did the background jobs last run.
// Settings are reported as set or not (and live/test for Stripe), never their values.
const NO_STORE = { "Cache-Control": "private, no-store" };

type Check = { name: string; ok: boolean | null; detail: string }; // ok null: not set up, and that's allowed

const has = (k: string) => Boolean(process.env[k]?.trim());

async function resendDomains(): Promise<Check> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { name: "Resend (email)", ok: false, detail: "RESEND_API_KEY isn't set: no emails are sent." };
  try {
    const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000), cache: "no-store" });
    // A sending-only key can't list domains; that's the safer kind of key, so it isn't a failure.
    if (r.status === 401 || r.status === 403) return { name: "Resend (email)", ok: true, detail: "Key is set (sending only, so the domain status can't be read here; see resend.com → Domains)." };
    if (!r.ok) return { name: "Resend (email)", ok: false, detail: `Resend answered ${r.status}.` };
    const j = (await r.json()) as { data?: { name: string; status: string }[] };
    const domains = j.data ?? [];
    const verified = domains.filter((d) => d.status === "verified").map((d) => d.name);
    return {
      name: "Resend (email)",
      ok: verified.length > 0,
      detail: domains.length ? domains.map((d) => `${d.name}: ${d.status}`).join(", ") : "No domain added in Resend yet.",
    };
  } catch (e) {
    return { name: "Resend (email)", ok: false, detail: `Couldn't reach Resend: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function GET() {
  const { user } = await viewer();
  if (!user || !isAdmin(user.login)) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });

  const stripeMode = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ? "test" : null;
  const settings: Check[] = [
    { name: "Database (Turso)", ok: has("TURSO_DATABASE_URL"), detail: has("TURSO_DATABASE_URL") ? "Set." : "TURSO_DATABASE_URL isn't set: nothing is saved." },
    { name: "GitHub token", ok: has("GITHUB_TOKEN"), detail: has("GITHUB_TOKEN") ? "Set." : "GITHUB_TOKEN isn't set: GitHub allows far fewer reads." },
    {
      name: "GitHub sign-in",
      ok: ["GITHUB_APP_SLUG", "GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET", "SESSION_SECRET"].every(has),
      detail: "GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and SESSION_SECRET.",
    },
    { name: "Chat (Anthropic)", ok: has("ANTHROPIC_API_KEY") ? true : null, detail: has("ANTHROPIC_API_KEY") ? `Set${process.env.CHAT_ENABLED === "off" ? ", but CHAT_ENABLED=off" : ""}.` : "Not set: chat is off." },
    {
      name: "Stripe (payments)",
      ok: process.env.PRO_ENABLED === "on" ? Boolean(stripeMode && has("STRIPE_WEBHOOK_SECRET")) : null,
      detail:
        process.env.PRO_ENABLED !== "on"
          ? "PRO_ENABLED isn't on: payments are off."
          : `${stripeMode ? `${stripeMode === "live" ? "Live" : "Test"} key` : "No STRIPE_SECRET_KEY"}; webhook secret ${has("STRIPE_WEBHOOK_SECRET") ? "set" : "missing"}.`,
    },
    { name: "Cron jobs", ok: has("CRON_SECRET"), detail: has("CRON_SECRET") ? "CRON_SECRET is set." : "CRON_SECRET isn't set: the daily jobs are refused." },
    {
      name: "Emails to admins",
      ok: has("ADMIN_EMAIL") ? true : null,
      detail: has("ADMIN_EMAIL") ? `ADMIN_EMAIL is set; ADMIN_NOTIFY=${process.env.ADMIN_NOTIFY || "each"}.` : "ADMIN_EMAIL isn't set: no alerts or daily summary.",
    },
    { name: "Personal sender", ok: has("EMAIL_FROM_PERSONAL") ? true : null, detail: has("EMAIL_FROM_PERSONAL") ? "Set." : "Not set: /admin/email only sends from hello@." },
  ];

  const [resend, ping, marks] = await Promise.all([
    resendDomains(),
    dbPing().then(
      (ms) => ({ name: "Database answer time", ok: ms < 1500, detail: `${ms} ms for a trivial query${ms >= 1500 ? ": slow" : ""}.` }),
      (e) => ({ name: "Database answer time", ok: false, detail: `No answer: ${e instanceof Error ? e.message : String(e)}` }),
    ),
    healthMarks().catch(() => []),
  ]);

  // Daily jobs should have run in the last ~26 hours.
  const DAILY = ["cron-trending", "cron-facebook", "cron-digest"];
  const LABEL: Record<string, string> = {
    "stripe-webhook": "Stripe webhook (last event)",
    "cron-trending": "Daily: trending repos",
    "cron-facebook": "Daily: Facebook Finds",
    "cron-digest": "Daily: admin summary email",
  };
  const runs = [...new Set([...Object.keys(LABEL), ...marks.map((m) => m.name)])].map((name) => {
    const m = marks.find((x) => x.name === name);
    const late = m && DAILY.includes(name) && Date.now() - m.at > 26 * 36e5;
    return { name: LABEL[name] ?? name, at: m?.at ?? null, ok: m ? m.ok && !late : null, detail: m ? `${m.note ?? ""}${late ? " (more than a day ago)" : ""}` : "Not seen since this page was added." };
  });

  return NextResponse.json({ checks: [ping, resend, ...settings], runs }, { headers: NO_STORE });
}

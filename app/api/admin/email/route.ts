import { NextResponse } from "next/server";
import { type EmailRef, getProblem, listEmails, logEmail, purchaseBySession, subscriptionById } from "@/lib/db";
import { EMAIL_ENABLED, isEmail, maskEmail, composeEmail, sendAdminEmail, type Composed, type EmailContext } from "@/lib/email";
import { PRO_ENABLED, stripe } from "@/lib/stripe";
import { isAdmin, viewer } from "@/lib/viewer";

// For site admins (ADMIN_GITHUB_LOGINS): write to one person about a problem they reported, a repo they bought or
// their Pro subscription, or to any address. GET says who it would go to; POST previews or sends (app/admin/email).
// Buyers' addresses are read from Stripe when needed and never stored; the log keeps them masked.
const NO_STORE = { "Cache-Control": "private, no-store" };
const KINDS = ["problem", "purchase", "subscription", "custom"] as const;

async function admin() {
  const { user } = await viewer();
  return user && isAdmin(user.login) ? user : null;
}

const parseRef = (kind: unknown, id: unknown): EmailRef | null => {
  if (!KINDS.includes(kind as EmailRef["kind"])) return null;
  const s = typeof id === "string" ? id.trim() : "";
  if (kind === "custom") return { kind, id: "" };
  if (kind === "problem" && !/^\d{1,12}$/.test(s)) return null;
  if (kind === "purchase" && !/^cs_[A-Za-z0-9_]{1,200}$/.test(s)) return null;
  if (kind === "subscription" && !/^sub_[A-Za-z0-9_]{1,200}$/.test(s)) return null;
  return { kind: kind as EmailRef["kind"], id: s };
};

// The checkout email for a purchase, or the customer's email for a subscription. Null when Stripe doesn't have one
// (or the payment was made in the other mode: a test purchase can't be read with the live key).
async function stripeEmail(ref: EmailRef, customer?: string): Promise<string | null> {
  if (!PRO_ENABLED()) return null;
  try {
    if (ref.kind === "purchase") {
      const s = await stripe().checkout.sessions.retrieve(ref.id);
      return s.customer_details?.email ?? s.customer_email ?? null;
    }
    if (ref.kind === "subscription" && customer) {
      const c = await stripe().customers.retrieve(customer);
      return "deleted" in c && c.deleted ? null : (c.email ?? null);
    }
  } catch (e) {
    console.error("gitmanual admin email: Stripe lookup failed:", e instanceof Error ? e.message : e);
  }
  return null;
}

async function context(ref: EmailRef): Promise<EmailContext | null> {
  const base = { ref, repo: null, name: null, to: null, toNote: null, details: null };
  if (ref.kind === "custom") return { ...base, title: "A new email", toNote: "Type the address." };
  if (ref.kind === "problem") {
    const p = await getProblem(Number(ref.id));
    if (!p) return null;
    return {
      ...base,
      title: `Problem #${p.id}${p.repo ? `: ${p.repo}` : ""}`,
      repo: p.repo || null,
      name: p.name ?? (p.githubLogin ? `@${p.githubLogin}` : null),
      to: p.email,
      toNote: p.email ? "The address they left with the report." : "They didn't leave an address. Type one if they gave it elsewhere.",
      details: p.message + (p.error ? `\n\n${p.error.slice(0, 1500)}` : ""),
    };
  }
  if (ref.kind === "purchase") {
    const p = await purchaseBySession(ref.id);
    if (!p) return null;
    const to = await stripeEmail(ref);
    return {
      ...base,
      title: `Purchase: ${p.fullName}${p.login ? ` by @${p.login}` : ""}`,
      repo: p.fullName,
      name: p.login ? `@${p.login}` : null,
      to,
      toNote: to ? "Their checkout email, from Stripe." : "Stripe has no email for this payment. Type one if you have it.",
    };
  }
  const s = await subscriptionById(ref.id);
  if (!s) return null;
  const to = await stripeEmail(ref, s.customer);
  return {
    ...base,
    title: `Pro${s.plan ? ` (${s.plan === "year" ? "yearly" : "monthly"})` : ""}${s.login ? `: @${s.login}` : ""}`,
    name: s.login ? `@${s.login}` : null,
    to,
    toNote: to ? "Their email on Stripe." : "Stripe has no email for this customer. Type one if you have it.",
  };
}

// ?kind=problem&id=12 → who it goes to and the emails already sent about it. No kind → every recent email.
export async function GET(req: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const q = new URL(req.url).searchParams;
  try {
    if (!q.get("kind")) return NextResponse.json({ enabled: EMAIL_ENABLED(), sent: await listEmails() }, { headers: NO_STORE });
    const ref = parseRef(q.get("kind"), q.get("id"));
    const ctx = ref && (await context(ref));
    if (!ref || !ctx) return NextResponse.json({ error: "Nothing found to write about." }, { status: 404, headers: NO_STORE });
    return NextResponse.json({ enabled: EMAIL_ENABLED(), context: ctx, sent: ref.kind === "custom" ? [] : await listEmails(ref) }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ error: "The database didn't answer. Try again in a minute." }, { status: 503, headers: NO_STORE });
  }
}

// { kind, id, to?, subject, body, format, key, preview? }. "to" replaces the address found for it.
export async function POST(req: Request) {
  const user = await admin();
  if (!user) return NextResponse.json({ error: "Admins only." }, { status: 403, headers: NO_STORE });
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const fail = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: NO_STORE });
  if (!b) return fail("Send JSON.");
  const ref = parseRef(b.kind, b.id);
  if (!ref) return fail("Pick what the email is about.");
  const subject = typeof b.subject === "string" ? b.subject.replace(/[\r\n]+/g, " ").trim() : "";
  const body = typeof b.body === "string" ? b.body : "";
  const format = b.format === "html" ? "html" : "markdown";
  const key = typeof b.key === "string" && /^[\w-]{8,64}$/.test(b.key) ? b.key : null;
  if (!subject || subject.length > 200) return fail("Write a subject (up to 200 characters).");
  if (!body.trim() || body.length > 100_000) return fail("Write the message (up to 100,000 characters).");

  let ctx: EmailContext | null;
  try {
    ctx = await context(ref);
  } catch {
    return fail("The database didn't answer. Try again in a minute.", 503);
  }
  if (!ctx) return fail("Nothing found to write about.", 404);
  const typed = typeof b.to === "string" ? b.to.trim() : "";
  if (typed && !isEmail(typed)) return fail("That address doesn't look right. One address, like name@example.com.");
  const to = typed || ctx.to;
  if (!to) return fail("There's no address for this. Type one.");

  const c: Composed = { subject, body, format };
  if (b.preview) return NextResponse.json({ to, ...composeEmail(c) }, { headers: NO_STORE });

  if (!EMAIL_ENABLED()) return fail("Sending is off: RESEND_API_KEY isn't set on this server.", 503);
  if (!key) return fail("Missing send key. Reload the page and try again.");
  const id = await sendAdminEmail(to, c, key);
  if (id === null) return fail("Resend didn't send it. The reason is in the Vercel logs (often the domain isn't verified yet).", 502);
  // Sent; a failed log line shouldn't make it look unsent.
  await logEmail({ ref, toHint: maskEmail(to), subject, admin: user.login, resendId: id || null }).catch((e) => console.error("gitmanual admin email: log failed:", e));
  return NextResponse.json({ sent: true, toHint: maskEmail(to) }, { headers: NO_STORE });
}

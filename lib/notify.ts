import { composeEmail, deliver, isEmail } from "./email";
import { SITE_URL } from "./site";

// Emails to the site's admins: a new problem report, a purchase, a new Pro member, the database not answering,
// and a daily summary (app/api/cron/digest). Sent with Resend from hello@, like the rest.
//   ADMIN_EMAIL=you@example.com (several: comma-separated). Not set: nothing is sent.
//   ADMIN_NOTIFY=each (default: every event, plus the daily summary) | daily (only the summary) | off
// Never in the way: a failure is logged and the request carries on.

const admins = () =>
  (process.env.ADMIN_EMAIL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(isEmail);
const mode = () => (["daily", "off"].includes(process.env.ADMIN_NOTIFY ?? "") ? (process.env.ADMIN_NOTIFY as "daily" | "off") : "each");

// key: the same event sent twice (a Stripe retry) is one email; Resend keeps keys for 24 hours.
export async function notifyAdmins(subject: string, markdown: string, key: string, opts: { summary?: boolean } = {}): Promise<void> {
  const to = admins();
  const m = mode();
  if (!to.length || m === "off" || (m === "daily" && !opts.summary)) return;
  const body = composeEmail({ subject, body: markdown, format: "markdown" });
  await Promise.all(
    to.map((addr, i) => deliver({ to: addr, subject: `[gitmanual] ${subject}`, key: `notify/${key}/${i}`, ...body }).catch((e) => console.error("gitmanual notify:", e))),
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

export function notifyProblem(p: { id: number; mode: string; repo: string; kind: string; message: string; email: string | null; githubLogin: string | null; name: string | null }) {
  const what = p.mode === "contact" ? "Message" : p.repo ? `Problem with ${p.repo}` : "Site problem";
  const who = p.githubLogin ? `@${p.githubLogin}` : (p.name ?? "someone");
  return notifyAdmins(
    `${what} from ${who}`,
    [
      `**${what}** (${p.kind}) from ${who}${p.email ? ", who left an email address" : ", no email address"}.`,
      clip(p.message, 600)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n"),
      `[${p.email ? "Reply" : "Open it"}](${SITE_URL}/admin/email?kind=problem&id=${p.id}) · [All problems](${SITE_URL}/admin/problems)`,
    ].join("\n\n"),
    `problem/${p.id}`,
  );
}

export function notifyPurchase(p: { session: string; fullName: string; amount: number; currency: string; login?: string | null }, live: boolean) {
  return notifyAdmins(
    `${live ? "" : "[Test] "}Report bought: ${p.fullName} (${money(p.amount, p.currency)})`,
    [
      `Someone${p.login ? ` (@${p.login})` : ""} bought the report for **${p.fullName}**: ${money(p.amount, p.currency)} before tax.`,
      `[Purchases](${SITE_URL}/admin/purchases) · [Email them](${SITE_URL}/admin/email?kind=purchase&id=${encodeURIComponent(p.session)})`,
    ].join("\n\n"),
    `purchase/${p.session}`,
  );
}

export function notifySubscription(s: { subscription: string; plan: string | null; login?: string | null }, live: boolean) {
  const plan = s.plan === "year" ? "yearly" : s.plan === "month" ? "monthly" : "";
  return notifyAdmins(
    `${live ? "" : "[Test] "}New Pro member${plan ? ` (${plan})` : ""}`,
    [
      `Someone${s.login ? ` (@${s.login})` : ""} subscribed to GitManual Pro${plan ? `, ${plan}` : ""}.`,
      `[Purchases](${SITE_URL}/admin/purchases) · [Email them](${SITE_URL}/admin/email?kind=subscription&id=${encodeURIComponent(s.subscription)})`,
    ].join("\n\n"),
    `subscription/${s.subscription}`,
  );
}

// The database not answering in time (lib/db.ts safely): at most one email an hour, across all servers (one
// Resend key per hour), with how many times this server saw it since its last one.
let dbMisses = 0;
let dbLastSent = 0;
export function notifyDbTrouble(detail: string) {
  dbMisses++;
  const now = Date.now();
  if (now - dbLastSent < 60 * 60 * 1000) return;
  dbLastSent = now;
  const n = dbMisses;
  dbMisses = 0;
  const hour = new Date(now).toISOString().slice(0, 13);
  void notifyAdmins(
    "The database is slow or not answering",
    [
      `One server saw the database fail ${n} ${n === 1 ? "time" : "times"} in the last hour. Latest: ${detail}.`,
      "Pages still load (they go on without it), but saving, counts and Pro checks may fail. Check Turso's status and usage, and the Vercel logs (search for \"gitmanual db\").",
      `[Health](${SITE_URL}/admin/health)`,
    ].join("\n\n"),
    `db/${hour}`,
  );
}

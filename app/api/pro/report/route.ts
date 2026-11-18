import { NextResponse } from "next/server";
import { hasRepo, purchasesFor, repoKey } from "@/lib/db";
import { parseRepoUrl } from "@/lib/github";
import { accessFor, proFor } from "@/lib/pro";
import { SITE_URL, sitePath } from "@/lib/site";
import { PRO_ENABLED, REPO_REPORT, reportPrice, stripe } from "@/lib/stripe";
import { viewer } from "@/lib/viewer";

// One repo, paid once (lib/stripe.ts REPO_REPORT): its Deep Inspection and PDF manuals, kept on the account.
//   POST {"repo": "owner/name", "back"?: "/owner/name/inspection"} → {"url": "https://checkout.stripe.com/..."}
//   GET → {"reports": [...]} the signed-in account's bought repos (/profile/reports)
const headers = { "Cache-Control": "private, no-store" };

export async function GET() {
  if (!PRO_ENABLED()) return NextResponse.json({ error: "Not available." }, { status: 404, headers });
  const { user, settle } = await viewer();
  if (!user) return NextResponse.json({ error: "Sign in with GitHub first.", signIn: true }, { status: 401, headers });
  try {
    const reports = (await purchasesFor(user.id)).map((p) => ({ repo: p.fullName, paidAt: p.paidAt, amount: p.amount, currency: p.currency }));
    return settle(NextResponse.json({ reports }, { headers }));
  } catch (e) {
    console.error("gitmanual reports:", e);
    return settle(NextResponse.json({ error: "Couldn't load your reports. Try again later." }, { status: 503, headers }));
  }
}

export async function POST(req: Request) {
  const fail = (error: string, status: number, extra: Record<string, unknown> = {}) => NextResponse.json({ error, ...extra }, { status, headers });
  if (!PRO_ENABLED()) return fail("Buying a repo report isn't available on this site.", 404);

  const body = (await req.json().catch(() => ({}))) as { repo?: string; back?: string };
  const ref = parseRepoUrl(body.repo ?? "");
  if (!ref || ref.ref) return fail("Expected repo: owner/name.", 400);
  const fullName = `${ref.owner}/${ref.repo}`;
  const back = sitePath(body.back) ?? `/${fullName}/inspection`;

  const { user, settle } = await viewer();
  if (!user) return fail("Sign in with GitHub first.", 401, { signIn: true });
  // Only repos with a manual: Deep Inspection reads the analysis made for it.
  if (!(await hasRepo(repoKey(ref.owner, ref.repo)))) return settle(fail("Open this repo's manual first, then buy its report.", 404));
  const { pro, bought } = await accessFor(user.id, fullName);
  if (pro) return settle(fail("You have Pro, which already includes this repo.", 409, { pro: true }));
  if (bought) return settle(fail("You already own this repo's report.", 409, { bought: true }));

  const price = await reportPrice();
  if (!price) return settle(fail("Checkout is unavailable right now. Try again later.", 503));

  try {
    const { subscription } = await proFor(user.id); // a past Pro member pays with the same Stripe customer
    const meta = { github_id: String(user.id), github_login: user.login, repo: fullName, product: REPO_REPORT.lookupKey };
    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      managed_payments: { enabled: true },
      line_items: [{ price: price.id, quantity: 1 }],
      client_reference_id: String(user.id),
      ...(subscription?.customer && { customer: subscription.customer }),
      metadata: meta,
      payment_intent_data: { metadata: meta, description: `GitManual report: ${fullName}` },
      success_url: `${SITE_URL}/api/pro/report/done?session_id={CHECKOUT_SESSION_ID}&back=${encodeURIComponent(back)}`,
      cancel_url: `${SITE_URL}${back}`,
    });
    if (!session.url) throw new Error("Stripe returned no checkout URL");
    return settle(NextResponse.json({ url: session.url }, { headers }));
  } catch (e) {
    console.error("gitmanual report checkout:", e);
    return settle(fail("Checkout is unavailable right now. Try again later.", 502));
  }
}

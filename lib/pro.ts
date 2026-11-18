import type Stripe from "stripe";
import { githubIdForSubscription, hasPurchase, savePurchase, saveSubscription, subscriptionFor, type Purchase, type SubscriptionRow } from "./db";
import { hasPro, PRO_ENABLED, REPO_REPORT, stripe, toRecord } from "./stripe";

// The one check every Pro feature uses: does this GitHub account have GitManual Pro right now?
// Without the database it answers no, so a Pro feature is never given away by mistake (chat itself pauses then).
export async function proFor(githubId: number | null | undefined): Promise<{ pro: boolean; subscription: SubscriptionRow | null }> {
  if (!githubId || !PRO_ENABLED()) return { pro: false, subscription: null };
  try {
    const subscription = await subscriptionFor(githubId);
    return { pro: hasPro(subscription), subscription };
  } catch (e) {
    console.error("gitmanual pro:", e);
    return { pro: false, subscription: null };
  }
}

export const isPro = async (githubId: number | null | undefined) => (await proFor(githubId)).pro;

// Which GitHub account a subscription belongs to: set on it at checkout (app/api/pro/checkout), or already known here.
async function ownerOf(s: Stripe.Subscription): Promise<number | null> {
  const fromMeta = Number(s.metadata?.github_id);
  if (Number.isSafeInteger(fromMeta) && fromMeta > 0) return fromMeta;
  return githubIdForSubscription(s.id);
}

// Copies a subscription's current state from Stripe. Always re-read from Stripe rather than taken from the event,
// so events arriving late or out of order can't leave an old state behind.
export async function syncSubscription(id: string, githubId?: number): Promise<SubscriptionRow | null> {
  const s = await stripe().subscriptions.retrieve(id);
  const owner = githubId ?? (await ownerOf(s));
  if (!owner) {
    console.error(`gitmanual pro: subscription ${id} has no GitHub account`);
    return null;
  }
  const record = toRecord(s, owner);
  await saveSubscription(record);
  return record;
}

// Back from checkout: the page asks right away instead of waiting for the webhook. Only for the account that paid.
export async function syncCheckout(sessionId: string, githubId: number): Promise<SubscriptionRow | null> {
  const session = await stripe().checkout.sessions.retrieve(sessionId);
  if (session.client_reference_id !== String(githubId) || session.mode !== "subscription" || !session.subscription) return null;
  const sub = typeof session.subscription === "string" ? session.subscription : session.subscription.id;
  return syncSubscription(sub, githubId);
}

// Deep Inspection and PDF manuals for one repo: with Pro, or bought for that repo once (REPO_REPORT).
// Any error answers no, like proFor.
export async function accessFor(githubId: number | null | undefined, repo: string): Promise<{ pro: boolean; bought: boolean }> {
  if (!githubId || !PRO_ENABLED()) return { pro: false, bought: false };
  const pro = await isPro(githubId);
  if (pro) return { pro, bought: false };
  const bought = await hasPurchase(githubId, repo).catch((e) => {
    console.error("gitmanual pro:", e);
    return false;
  });
  return { pro, bought };
}

// A paid repo-report checkout, recorded for the account and repo set on it at checkout (app/api/pro/report).
// Used by the return from checkout and by the webhook; recording twice is harmless.
export async function recordPurchase(session: Stripe.Checkout.Session, githubId?: number): Promise<Purchase | null> {
  const owner = Number(session.client_reference_id);
  const fullName = session.metadata?.repo ?? "";
  if (session.mode !== "payment" || session.metadata?.product !== REPO_REPORT.lookupKey) return null;
  // GitHub owners are letters, digits and hyphens; a repo name is never . or ..
  if (!Number.isSafeInteger(owner) || owner <= 0 || (githubId && githubId !== owner) || !/^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[\w.-]+$/.test(fullName)) return null;
  if (session.payment_status !== "paid") return null;
  const p: Purchase = {
    session: session.id,
    githubId: owner,
    repo: fullName.toLowerCase(),
    fullName,
    amount: session.amount_subtotal ?? REPO_REPORT.amount,
    currency: session.currency ?? "usd",
    paidAt: (session.created ?? Math.floor(Date.now() / 1000)) * 1000,
  };
  await savePurchase(p);
  return p;
}

// Back from a repo-report checkout: read the session from Stripe (never trust the URL) and record it.
export async function syncReportCheckout(sessionId: string, githubId: number): Promise<Purchase | null> {
  return recordPurchase(await stripe().checkout.sessions.retrieve(sessionId), githubId);
}

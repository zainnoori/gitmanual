import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { markHealth } from "@/lib/db";
import { sendProWelcome, sendReportThanks } from "@/lib/email";
import { notifyPurchase, notifySubscription } from "@/lib/notify";
import { recordPurchase, syncSubscription } from "@/lib/pro";
import { PRO_ENABLED, stripe, WEBHOOK_EVENTS as EVENTS } from "@/lib/stripe";

// Stripe tells the site when a subscription starts, renews, changes or ends; that's what turns Pro on and off.
// It also records one-time repo reports (checkout.session.completed with mode "payment").
// Every event is checked against STRIPE_WEBHOOK_SECRET, and the subscription is then read fresh from Stripe.
// Set the endpoint in Stripe (Developers → Webhooks) to https://<site>/api/stripe/webhook with WEBHOOK_EVENTS (lib/stripe.ts).
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!PRO_ENABLED() || !secret) return NextResponse.json({ error: "Not configured." }, { status: 404 });

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(await req.text(), req.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return NextResponse.json({ error: "Bad signature." }, { status: 400 });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const githubId = Number(s.client_reference_id);
      if (s.mode === "subscription" && s.subscription && Number.isSafeInteger(githubId) && githubId > 0) {
        const sub = await syncSubscription(typeof s.subscription === "string" ? s.subscription : s.subscription.id, githubId);
        if (sub) {
          await thank(s, (to) => sendProWelcome({ to, plan: sub.plan, session: s.id, live: event.livemode }));
          await notifySubscription({ subscription: sub.subscription, plan: sub.plan, login: s.metadata?.github_login }, event.livemode);
        }
      }
      // A one-time repo report (app/api/pro/report). recordPurchase checks it's ours and paid.
      if (s.mode === "payment") await reportPaid(s, event.livemode);
    } else if (event.type === "checkout.session.async_payment_succeeded") {
      await reportPaid(event.data.object, event.livemode);
    } else if ((EVENTS as readonly string[]).includes(event.type) && event.type.startsWith("customer.subscription.")) {
      await syncSubscription((event.data.object as Stripe.Subscription).id);
    }
  } catch (e) {
    // A 500 makes Stripe send the event again later.
    console.error("gitmanual stripe webhook:", e);
    await markHealth("stripe-webhook", false, `${event.type}: ${e instanceof Error ? e.message : String(e)}`);
    return NextResponse.json({ error: "Couldn't record it." }, { status: 500 });
  }
  await markHealth("stripe-webhook", true, event.type);
  return NextResponse.json({ received: true });
}

async function reportPaid(s: Stripe.Checkout.Session, live: boolean) {
  const p = await recordPurchase(s);
  if (!p) return;
  await thank(s, (to) => sendReportThanks({ to, fullName: p.fullName, session: s.id, live }));
  await notifyPurchase({ ...p, login: s.metadata?.github_login }, live);
}

// The thank-you goes to the email given at checkout. It's sent only after the payment is recorded, and a failed
// email is logged, not retried: Stripe resending the event would only repeat the recording.
async function thank(s: Stripe.Checkout.Session, send: (to: string) => Promise<boolean>) {
  const to = s.customer_details?.email ?? s.customer_email;
  if (!to) return;
  await send(to).catch((e) => console.error("gitmanual email:", e));
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type Stripe from "stripe";

// One repo bought once (app/api/pro/report): only a paid checkout of the repo report, for the account that paid,
// is recorded, and the return page and the webhook recording the same session count once.

process.env.GITMANUAL_DB = join(mkdtempSync(join(tmpdir(), "gitmanual-buy-")), "test.db");
delete process.env.TURSO_DATABASE_URL;
process.env.PRO_ENABLED = "on";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";

const { recordPurchase, accessFor } = await import("../lib/pro");
const { purchasesFor } = await import("../lib/db");

const session = (over: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: "cs_test_1",
    mode: "payment",
    payment_status: "paid",
    client_reference_id: "42",
    metadata: { repo: "Acme/Tool", product: "gitmanual_repo_report" },
    amount_subtotal: 499,
    currency: "usd",
    created: 1_800_000_000,
    ...over,
  }) as Stripe.Checkout.Session;

test("only a paid repo-report checkout for the paying account is recorded", async () => {
  assert.equal(await recordPurchase(session({ payment_status: "unpaid" })), null);
  assert.equal(await recordPurchase(session({ mode: "subscription" })), null);
  assert.equal(await recordPurchase(session({ metadata: { repo: "Acme/Tool", product: "something_else" } })), null);
  assert.equal(await recordPurchase(session({ metadata: { repo: "../evil", product: "gitmanual_repo_report" } })), null);
  assert.equal(await recordPurchase(session(), 7), null, "the return page only records the signed-in account's own checkout");
  assert.deepEqual(await purchasesFor(42), []);
});

test("recorded once, under the lower-case repo; it opens that repo only", async () => {
  await recordPurchase(session(), 42);
  await recordPurchase(session()); // the webhook, for the same session
  const list = await purchasesFor(42);
  assert.equal(list.length, 1);
  assert.equal(list[0].repo, "acme/tool");
  assert.equal(list[0].fullName, "Acme/Tool");
  assert.equal(list[0].amount, 499);
  assert.equal(list[0].paidAt, 1_800_000_000_000);
  // isPro reads the (empty) subscriptions table: no Pro, but the bought repo is open.
  assert.deepEqual(await accessFor(42, "ACME/tool"), { pro: false, bought: true });
  assert.deepEqual(await accessFor(42, "acme/other"), { pro: false, bought: false });
  assert.deepEqual(await accessFor(43, "acme/tool"), { pro: false, bought: false });
});

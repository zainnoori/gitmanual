import assert from "node:assert/strict";
import { test } from "node:test";

// Resend is never called: fetch is replaced, and the key is a dummy.
process.env.RESEND_API_KEY = "re_dummy";
process.env.ADMIN_EMAIL = "admin@example.com, not-an-address";
const sent: { key: string; body: any }[] = [];
globalThis.fetch = (async (_u: string, i: RequestInit) => {
  sent.push({ key: (i.headers as Record<string, string>)["Idempotency-Key"], body: JSON.parse(String(i.body)) });
  return new Response('{"id":"x"}');
}) as typeof fetch;
const n = await import("../lib/notify");

test("a new problem emails the admins once, with a reply link; bad addresses are skipped", async () => {
  sent.length = 0;
  await n.notifyProblem({ id: 7, mode: "manual", repo: "a/b", kind: "step-failed", message: "it broke\nbadly", email: "x@y.com", githubLogin: "octo", name: null });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.to, ["admin@example.com"]);
  assert.equal(sent[0].body.subject, "[gitmanual] Problem with a/b from @octo");
  assert.equal(sent[0].key, "notify/problem/7/0");
  assert.match(sent[0].body.text, /admin\/email\?kind=problem&id=7/);
});

test("ADMIN_NOTIFY=daily keeps only the summary; off sends nothing", async () => {
  sent.length = 0;
  process.env.ADMIN_NOTIFY = "daily";
  await n.notifyPurchase({ session: "cs_live_1", fullName: "a/b", amount: 499, currency: "usd" }, true);
  await n.notifyAdmins("Daily summary", "x", "digest/1", { summary: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.subject, "[gitmanual] Daily summary");
  process.env.ADMIN_NOTIFY = "off";
  await n.notifyAdmins("Daily summary", "x", "digest/2", { summary: true });
  assert.equal(sent.length, 1);
  delete process.env.ADMIN_NOTIFY;
});

test("database trouble: at most one email an hour per server", async () => {
  sent.length = 0;
  n.notifyDbTrouble("no answer in 5 s");
  n.notifyDbTrouble("no answer in 5 s");
  n.notifyDbTrouble("SQLITE_BUSY");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  assert.match(sent[0].key, /^notify\/db\/\d{4}-\d\d-\d\dT\d\d\/0$/);
});

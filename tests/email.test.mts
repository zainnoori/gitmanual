import assert from "node:assert/strict";
import { test } from "node:test";

// Resend is never called: fetch is replaced, and the key is a dummy.
process.env.RESEND_API_KEY = "re_dummy";
const sent: { url: string; headers: Record<string, string>; body: any }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
  return new Response("{}", { status: 200 });
}) as typeof fetch;
const { sendReportThanks, sendProWelcome } = await import("../lib/email");

test("report thank-you: link to the report, one idempotency key per checkout, escaped HTML", async () => {
  assert.equal(await sendReportThanks({ to: "buyer@example.com", fullName: "a-b/c.d", session: "cs_live_1", live: true }), true);
  const m = sent.at(-1)!;
  assert.equal(m.url, "https://api.resend.com/emails");
  assert.equal(m.headers["Idempotency-Key"], "report-thanks/cs_live_1");
  assert.deepEqual(m.body.to, ["buyer@example.com"]);
  assert.equal(m.body.subject, "Your gitmanual report for a-b/c.d");
  assert.match(m.body.text, /\/a-b\/c\.d\/inspection/);
  assert.match(m.body.html, /href="[^"]+\/a-b\/c\.d\/inspection"/);
  assert.match(m.body.text, /\/pro\b/);
});

test("Pro welcome in test mode is tagged", async () => {
  await sendProWelcome({ to: "x@example.com", plan: "year", session: "cs_test_2", live: false });
  const m = sent.at(-1)!;
  assert.equal(m.body.subject, "[Test] Welcome to GitManual Pro");
  assert.match(m.body.text, /\(yearly\)/);
  assert.equal(m.headers["Idempotency-Key"], "pro-welcome/cs_test_2");
});

test("a Resend error is reported as not sent", async () => {
  globalThis.fetch = (async () => new Response('{"message":"domain not verified"}', { status: 403 })) as typeof fetch;
  const err = console.error;
  console.error = () => {};
  assert.equal(await sendProWelcome({ to: "x@example.com", plan: null, session: "s", live: true }), false);
  console.error = err;
});

test("admin Markdown: escaped text, links, lists, bold; nothing raw gets through", async () => {
  const { markdownToHtml } = await import("../lib/email");
  const html = markdownToHtml("Hi <b>x</b>,\n\nSee [the manual](https://gitmanual.com/a/b) or https://gitmanual.com/pro.\n\n- one **two**\n- `npm i`\n\n[bad](javascript:alert(1))");
  assert.match(html, /Hi &lt;b&gt;x&lt;\/b&gt;,/);
  assert.match(html, /<a href="https:\/\/gitmanual\.com\/a\/b"[^>]*>the manual<\/a>/);
  assert.match(html, /<a href="https:\/\/gitmanual\.com\/pro"[^>]*>https:\/\/gitmanual\.com\/pro<\/a>\./);
  assert.match(html, /<ul[^>]*><li[^>]*>one <strong>two<\/strong><\/li><li[^>]*><code[^>]*>npm i<\/code><\/li><\/ul>/);
  assert.doesNotMatch(html, /href="javascript/);
});

test("admin addresses: one plain address only; the log keeps it masked", async () => {
  const { isEmail, maskEmail, composeEmail } = await import("../lib/email");
  assert.equal(isEmail("someone@example.com"), true);
  for (const bad of ["a@b", "a b@c.com", "a@b.com, c@d.com", "Name <a@b.com>", "a@b.com\nBcc: c@d.com"]) assert.equal(isEmail(bad), false, bad);
  assert.equal(maskEmail("someone@example.com"), "s***@example.com");
  const doc = composeEmail({ subject: "s", body: "<html><body><p>Hi &amp; <a href=\"https://x.com\">there</a></p></body></html>", format: "html" });
  assert.match(doc.html, /^<html>/);
  assert.equal(doc.text, "Hi & there (https://x.com)");
});

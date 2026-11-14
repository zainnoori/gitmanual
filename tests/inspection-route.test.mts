import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

// Deep Inspection is Pro-only: signed-out and free visitors never get report data, Pro members get the saved report
// or a new one. Sign-in, Pro and the inspection itself are stand-ins; the budget runs against a throwaway database.

process.env.GITMANUAL_DB = join(mkdtempSync(join(tmpdir(), "gitmanual-insp-")), "test.db");
delete process.env.TURSO_DATABASE_URL;
process.env.PRO_ENABLED = "on";
process.env.STRIPE_SECRET_KEY = "sk_test_fake";

const lib = (path: string) => new URL(`../lib/${path}`, import.meta.url).href;
let signedIn: { id: number; login: string } | null = null;
const proUsers = new Set<number>();
const built: string[] = [];
const REPORT = { repo: "acme/tool", grades: { overall: "B" } };

mock.module(lib("viewer.ts"), { exports: { viewer: async () => ({ user: signedIn && { ...signedIn, token: "t" }, settle: (r: unknown) => r }), isAdmin: () => false } });
mock.module(lib("pro.ts"), { exports: { isPro: async (id: number) => proUsers.has(id), proFor: async () => ({ pro: false, subscription: null }) } });
mock.module(lib("inspection/index.ts"), {
  exports: {
    saved: async () => ({ inspection: REPORT, fresh: true }),
    inspect: async (ref: { owner: string; repo: string }, account: string) => {
      built.push(`${ref.owner}/${ref.repo}:${account}`);
      return { inspection: REPORT, fresh: true };
    },
    InspectionError: class extends Error {},
  },
});

const { GET, POST } = await import("../app/api/inspection/route");
const get = async () => (await GET(new Request("http://localhost/api/inspection?repo=acme/tool"))).json();
const post = async () => {
  const res = await POST(new Request("http://localhost/api/inspection", { method: "POST", body: JSON.stringify({ repo: "acme/tool" }) }));
  return { status: res.status, body: await res.json(), cache: res.headers.get("Cache-Control") };
};

test("signed out: no report, and inspecting asks for sign-in", async () => {
  signedIn = null;
  assert.deepEqual(await get(), { signedIn: false, login: null, pro: false, inspection: null });
  const r = await post();
  assert.equal(r.status, 401);
  assert.equal(built.length, 0);
});

test("free account: no report, and inspecting offers Pro", async () => {
  signedIn = { id: 1, login: "free" };
  const g = await get();
  assert.equal(g.inspection, null);
  assert.equal(g.login, "free"); // so the page can address them before offering Pro
  const r = await post();
  assert.equal(r.status, 402);
  assert.equal(built.length, 0);
});

test("Pro: the saved report, a new one on request, never cached by the CDN", async () => {
  signedIn = { id: 2, login: "pro" };
  proUsers.add(2);
  const g = await get();
  assert.equal(g.pro, true);
  assert.deepEqual(g.inspection, REPORT);
  assert.equal(g.left, 50);
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(r.cache, "private, no-store");
  assert.deepEqual(built, ["acme/tool:2"]);
});

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";

// Saved repos (/profile/saved): the /api/saved route against a throwaway SQLite file, signed in and out.

process.env.GITMANUAL_DB = join(mkdtempSync(join(tmpdir(), "gitmanual-saved-")), "test.db");
delete process.env.TURSO_DATABASE_URL;
process.env.RATE_LIMITS = "off";

const lib = (path: string) => new URL(`../lib/${path}`, import.meta.url).href;
let signedIn: { id: number; login: string } | null = { id: 7, login: "pat" };
mock.module(lib("viewer.ts"), {
  exports: { viewer: async () => ({ user: signedIn && { ...signedIn, token: "t" }, settle: (r: unknown) => r }), isAdmin: () => false },
});

const route = await import("../app/api/saved/route.ts");
const db = await import("../lib/db.ts");

const call = async (method: "GET" | "POST" | "DELETE", body?: object, query = "") => {
  const req = new Request(`http://x/api/saved${query}`, { method, body: body ? JSON.stringify(body) : undefined });
  const res = method === "GET" ? await route.GET(req) : method === "POST" ? await route.POST(req) : await route.DELETE(req);
  return { status: res.status, json: (await res.json()) as any };
};

test("save, change status, see the list, remove", async () => {
  signedIn = { id: 7, login: "pat" };
  assert.equal((await call("GET", undefined, "?repo=acme/tool")).json.save, null);

  const saved = await call("POST", { repo: "Acme/Tool", os: "mac" });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.save.status, "try");
  assert.equal(saved.json.save.key, "acme/tool");

  const changed = await call("POST", { repo: "acme/tool", os: "linux", status: "installed" });
  assert.equal(changed.json.save.status, "installed");
  assert.equal(changed.json.save.os, "linux");
  assert.equal(changed.json.save.savedAt, saved.json.save.savedAt, "keeps when it was first saved");

  const list = await call("GET");
  assert.equal(list.json.login, "pat");
  assert.deepEqual(list.json.saves.map((s: any) => s.key), ["acme/tool"]);

  // Someone else's list is separate.
  signedIn = { id: 8, login: "sam" };
  assert.equal((await call("GET")).json.saves.length, 0);

  signedIn = { id: 7, login: "pat" };
  await call("DELETE", { repo: "acme/tool" });
  assert.equal((await call("GET")).json.saves.length, 0);
});

test("bad input and signed out", async () => {
  signedIn = { id: 7, login: "pat" };
  assert.equal((await call("POST", { repo: "acme/tool", os: "amiga" })).status, 400);
  assert.equal((await call("POST", { repo: "acme/tool", os: "mac", status: "loved" })).status, 400);
  assert.equal((await call("POST", { repo: "not a repo", os: "mac" })).status, 400);
  signedIn = null;
  assert.equal((await call("GET")).json.login, null);
  assert.equal((await call("POST", { repo: "acme/tool", os: "mac" })).status, 401);
});

test("new release since saved, and 'Got it'", async () => {
  signedIn = { id: 9, login: "lee" };
  const data = (tag: string) => ({
    meta: { fullName: "acme/app", topics: [], archived: false },
    analysis: { stacks: [], envVars: [] },
    install: { release: { tag, assets: [] }, platforms: [] },
  });
  // A repo on the shelf: only its release tag matters here.
  await db.strictly(async (c) => {
    await c.execute({
      sql: "INSERT OR REPLACE INTO repos (key, full_name, description, stars, language, difficulty, data, analyzed_at, views, last_viewed) VALUES (?, ?, NULL, 1, NULL, 'Easy', ?, 0, 0, 0)",
      args: ["acme/app", "acme/app", JSON.stringify(data("v1"))],
    });
  });
  await call("POST", { repo: "acme/app", os: "mac" });
  let [s] = (await call("GET")).json.saves;
  assert.equal(s.releaseTag, "v1");
  assert.equal(s.latestTag, "v1");

  await db.strictly((c) => c.execute({ sql: "UPDATE repos SET data = ? WHERE key = ?", args: [JSON.stringify(data("v2")), "acme/app"] }));
  [s] = (await call("GET")).json.saves;
  assert.equal(s.latestTag, "v2");
  assert.equal(s.releaseTag, "v1", "still the one from when it was saved");

  await call("POST", { repo: "acme/app", seen: true });
  [s] = (await call("GET")).json.saves;
  assert.equal(s.releaseTag, "v2");
});

test("bulk status, bulk remove and undo", async () => {
  signedIn = { id: 11, login: "kim" };
  await call("POST", { repo: "a/one", os: "mac" });
  await call("POST", { repo: "a/two", os: "linux" });
  await call("POST", { repo: "a/three", os: "windows", status: "installed" });

  const bulk = await call("POST", { repos: ["a/one", "a/two", "a/missing"], status: "dropped" });
  assert.equal(bulk.status, 200);
  assert.equal(bulk.json.saves.length, 2, "only repos already saved change");
  let list = (await call("GET")).json.saves;
  const by = (k: string) => list.find((s: any) => s.key === k);
  assert.equal(by("a/one").status, "dropped");
  assert.equal(by("a/two").os, "linux", "keeps its computer");
  assert.equal(by("a/missing"), undefined, "a status change never saves a new repo");

  const before = list.filter((s: any) => s.key !== "a/three").map(({ key, os, status, savedAt, updatedAt, releaseTag }: any) => ({ key, os, status, savedAt, updatedAt, releaseTag }));
  assert.equal((await call("DELETE", { repos: ["a/one", "a/two"] })).json.removed, 2);
  assert.equal((await call("GET")).json.saves.length, 1);

  assert.equal((await call("POST", { restore: before })).json.restored, 2);
  list = (await call("GET")).json.saves;
  assert.equal(list.length, 3);
  assert.deepEqual(
    before.map((b: any) => list.find((s: any) => s.key === b.key)).map(({ key, os, status, savedAt, updatedAt, releaseTag }: any) => ({ key, os, status, savedAt, updatedAt, releaseTag })),
    before,
    "back exactly as they were",
  );

  assert.equal((await call("POST", { restore: [{ key: "a/x", os: "amiga", status: "try", savedAt: 1, updatedAt: 1, releaseTag: null }] })).status, 400);
  assert.equal((await call("POST", { repos: Array.from({ length: 101 }, (_, i) => `a/r${i}`), status: "try" })).status, 400);
});

test("undo can't take the list past its limit", async () => {
  signedIn = { id: 23, login: "lee" };
  const row = (i: number) => ({ key: `b/r${i}`, os: "mac", status: "try", savedAt: 1, updatedAt: 1, releaseTag: null });
  for (let i = 0; i < db.MAX_SAVES; i += 100) assert.equal((await call("POST", { restore: Array.from({ length: 100 }, (_, j) => row(i + j)) })).status, 200);
  assert.equal((await call("GET")).json.saves.length, db.MAX_SAVES);
  assert.equal((await call("POST", { restore: [row(0)] })).status, 200, "putting back one already there is fine");
  assert.equal((await call("POST", { restore: [row(db.MAX_SAVES)] })).status, 409);
  assert.equal((await call("GET")).json.saves.length, db.MAX_SAVES);
});

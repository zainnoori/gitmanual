import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// "Something wrong?" reports (app/api/problems): what's accepted, what's trimmed, and the admin list.
process.env.GITMANUAL_DB = join(mkdtempSync(join(tmpdir(), "gitmanual-problems-")), "test.db");
delete process.env.TURSO_DATABASE_URL;

const { checkProblem } = await import("../lib/problems");
const { listProblems, saveProblem, setProblemStatus } = await import("../lib/db");

const good = { repo: "Acme/Tool", os: "mac", kind: "step", step: 2, stepTitle: "Install the dependencies", message: "npm install fails", error: "ERR! 404", email: "me@example.com", version: 14 };

test("a report needs a repo, a system, a kind and a few words", () => {
  assert.equal(typeof checkProblem({ ...good, repo: "../x" }), "string");
  assert.equal(typeof checkProblem({ ...good, os: "beos" }), "string");
  assert.equal(typeof checkProblem({ ...good, kind: "rant" }), "string");
  assert.equal(typeof checkProblem({ ...good, message: "  hi " }), "string");
  assert.equal(typeof checkProblem({ ...good, email: "not-an-email" }), "string");
  assert.equal(typeof checkProblem({ ...good, email: "" }), "string", "every report needs a way to reply");
  assert.equal(typeof checkProblem({ ...good, email: "   " }), "string");
});

test("it keeps what's useful and trims the rest", () => {
  const p = checkProblem({ ...good, message: "x".repeat(5000), step: 999, email: " me@example.com " });
  assert.ok(typeof p !== "string");
  assert.equal(p.message.length, 2000);
  assert.equal(p.step, null);
  assert.equal(p.stepTitle, null, "no step, no step title");
  assert.equal(p.email, "me@example.com");
  assert.equal(p.version, 14);
});

test("saved reports are listed newest first and can be marked fixed", async () => {
  const p = checkProblem(good);
  assert.ok(typeof p !== "string");
  await saveProblem({ ...p, githubLogin: null });
  await saveProblem({ ...p, message: "second one", githubLogin: "someone" });
  const open = await listProblems("open");
  assert.equal(open.length, 2);
  assert.equal(open[0].message, "second one");
  assert.equal(open[1].step, 2);
  assert.equal(open[1].stepTitle, "Install the dependencies");
  await setProblemStatus(open[0].id, "fixed");
  assert.equal((await listProblems("open")).length, 1);
  assert.equal((await listProblems("fixed"))[0].githubLogin, "someone");
  assert.equal((await listProblems("all")).length, 2);
});

test("from the footer: no system or step, a repo only if given, always an email", () => {
  const site = { kind: "payment", os: "", repo: "", message: "Charged but still locked", email: "me@example.com", page: "/acme/tool/inspection", step: 3, version: 14 };
  const p = checkProblem(site);
  assert.ok(typeof p !== "string");
  assert.equal(p.repo, "");
  assert.equal(p.os, "");
  assert.equal(p.step, null);
  assert.equal(p.version, 0);
  assert.equal(p.page, "/acme/tool/inspection");
  assert.equal(typeof checkProblem({ ...site, email: "" }), "string", "payments need a way to reply");
  assert.equal(typeof checkProblem({ ...site, kind: "manual", email: "", repo: "Acme/Tool" }), "string", "nor any other report");
  const manual = checkProblem({ ...site, kind: "manual", repo: "https://github.com/Acme/Tool/" });
  assert.ok(typeof manual !== "string");
  assert.equal(manual.repo, "Acme/Tool");
  assert.equal(typeof checkProblem({ ...site, kind: "step" }), "string", "manual kinds need a manual");
  assert.equal((checkProblem({ ...site, page: "https://evil.example" }) as { page: string | null }).page, null);
});

test("contact messages: their own topics, a name, and always an email", async () => {
  const msg = { mode: "contact", kind: "advertising", name: " Sam ", message: "We'd like to sponsor the shelf.", email: "sam@example.com", os: "mac", step: 2 };
  const p = checkProblem(msg);
  assert.ok(typeof p !== "string");
  assert.equal(p.mode, "contact");
  assert.equal(p.name, "Sam");
  assert.equal(p.os, "", "a message has no system");
  assert.equal(p.step, null);
  assert.equal(typeof checkProblem({ ...msg, email: "" }), "string");
  assert.equal(typeof checkProblem({ ...msg, kind: "feedback", email: "" }), "string", "feedback too: we may want to ask back");
  assert.equal(typeof checkProblem({ ...msg, kind: "step" }), "string", "manual topics aren't contact topics");
  assert.equal((checkProblem({ ...good, name: "Sam" }) as { name: string | null }).name, null, "only messages keep a name");
  await saveProblem({ ...p, githubLogin: null });
  const saved = (await listProblems("open")).find((x) => x.mode === "contact");
  assert.equal(saved?.name, "Sam");
  assert.equal(saved?.kind, "advertising");
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import type { Facts } from "../lib/inspection/collect";
import { untar } from "../lib/inspection/archive";
import { finish } from "../lib/inspection/rules";
import { commands, envReads, projectKind, secrets, setupFindings, type Files } from "../lib/inspection/setup";

// "Before you run it": the checks that compare what a repo's docs say with what its files show. Each check is tried
// on a small made-up repo where it should fire, and on one where it shouldn't.

const facts = (over: Partial<Facts> = {}): Facts =>
  ({
    collectedAt: Date.now(),
    repo: { fullName: "acme/tool", htmlUrl: "https://github.com/acme/tool", defaultBranch: "main", stars: 500, topics: [], description: null },
    releases: [],
    deps: null,
    ci: null,
    texts: {},
    paths: [],
    unavailable: {},
    ...over,
  }) as unknown as Facts;
const repo = (files: Record<string, string>, extra: string[] = []): Files => ({ files, paths: [...Object.keys(files), ...extra], whole: true });
const run = (files: Files, f = facts()) => setupFindings({ facts: f, files, link: (p, l) => `https://github.com/acme/tool/blob/abc/${p}${l ? `#L${l}` : ""}` }).findings.map(finish);
const find = (all: ReturnType<typeof run>, id: string) => all.find((x) => x.id === id);

const APP = {
  "package.json": JSON.stringify({ name: "tool", private: true, scripts: { dev: "next dev", build: "next build", start: "next start" }, dependencies: { next: "15", pg: "8" }, engines: { node: ">=20.9" } }, null, 2),
  "Dockerfile": "FROM node:22\nCOPY . .\nRUN npm ci\n",
  "src/app/page.tsx": "export default function Page() { return null }",
};

test("documented scripts, make targets and files must exist", () => {
  const files = repo({
    ...APP,
    "README.md": "# Tool\n\n```bash\ngit clone https://github.com/acme/tool\ncd tool\ncp .env.example .env\nnpm install\nnpm run setup\nmake bootstrap\n./scripts/init.sh\n```\n",
    Makefile: "build:\n\tgo build\n",
  });
  const all = run(files);
  assert.match(find(all, "setup.scripts")!.text, /"setup" script \(line 8\)/);
  assert.equal(find(all, "setup.scripts")!.priority, "blocker");
  assert.equal(find(all, "setup.scripts")!.evidence![0].url, "https://github.com/acme/tool/blob/abc/README.md#L8");
  assert.match(find(all, "setup.make")!.text, /make bootstrap/);
  assert.match(find(all, "setup.files")!.text, /\.env\.example.*scripts\/init\.sh/);
});

test("steps that match the repo pass, and files made by earlier steps or ignored by git aren't flagged", () => {
  const files = repo(
    {
      ...APP,
      ".gitignore": "/dist\n.env\n",
      ".env.example": "DATABASE_URL=postgres://localhost/tool\n",
      "README.md": "```sh\ncp .env.example .env\nsource .env\nnpm install\nnpm run dev\nnode dist/server.js\nyarn playwright install\n```\nThen `npm run build`.\n",
    },
    ["src/app/page.tsx"],
  );
  const all = run(files);
  assert.equal(find(all, "setup.scripts"), undefined);
  assert.equal(find(all, "setup.files"), undefined);
  assert.equal(find(all, "setup.steps")!.status, "pass");
});

test("versions: the docs going below what the files require is flagged as important (the files win); a newer pin isn't", () => {
  const old = run(repo({ ...APP, "README.md": "## Requirements\n\n- Node.js 18 or newer\n- npm\n" }));
  const v = find(old, "setup.versions")!;
  assert.match(v.text, /README\.md says Node\.js 18.*package\.json requires Node\.js >=20\.9/);
  assert.equal(v.priority, "important");
  // An old requirement hidden in an HTML comment isn't documentation (yt-dlp).
  assert.equal(find(run(repo({ ...APP, "README.md": "Needs Node 20.9+.\n<!-- Node.js 12 or newer -->\n" })), "setup.versions"), undefined);
  // The Dockerfile pins 22, above the minimum: fine. "As of Go 1.21" style history isn't a requirement.
  assert.equal(find(run(repo({ ...APP, "README.md": "Needs Node 20.9+. Support for Node 16 was dropped." })), "setup.versions"), undefined);
  const nvm = run(repo({ ...APP, ".nvmrc": "18\n", "README.md": "Run `npm run dev`." }));
  assert.match(find(nvm, "setup.versions")!.text, /\.nvmrc picks Node\.js 18/);
});

test("the docs install with npm but the repo is set up for pnpm", () => {
  const all = run(repo({ ...APP, "pnpm-lock.yaml": "lockfileVersion: 9", "README.md": "```\nnpm install\nnpm run dev\n```" }));
  assert.match(find(all, "setup.manager")!.title, /Docs use npm, the repo uses pnpm/);
});

test("settings the code reads but no example or doc mentions", () => {
  const files = repo({
    ...APP,
    ".env.example": "DATABASE_URL=\nNEXTAUTH_SECRET=\n",
    "src/lib/db.ts": "export const db = connect(process.env.DATABASE_URL);\nconst key = process.env.STRIPE_SECRET_KEY;\nconst bucket = process.env.S3_BUCKET;\nconst level = process.env.SAMPLE_RATE ?? '1';",
    "src/lib/ai.ts": "const k = process.env.OPENAI_API_KEY;\nconst { REDIS_URL, QUEUE = 'jobs' } = process.env;",
    "tests/setup.ts": "process.env.TEST_ONLY_THING;",
    "README.md": "Copy `.env.example`.",
  });
  const reads = envReads(files).map((r) => r.name);
  assert.ok(reads.includes("QUEUE") && !reads.includes("TEST_ONLY_THING") && !reads.includes("NODE_ENV"));
  const env = find(run(files), "config.env")!;
  assert.match(env.title, /missing from \.env\.example/);
  assert.match(env.text, /STRIPE_SECRET_KEY, S3_BUCKET, OPENAI_API_KEY, REDIS_URL/);
  assert.doesNotMatch(env.text, /DATABASE_URL|NEXTAUTH_SECRET/);
  assert.equal(env.priority, "improvement"); // reading a setting isn't needing it
  const acct = find(run(files), "services.accounts")!;
  assert.match(acct.text, /You'll need Stripe and OpenAI/);
  assert.match(acct.text, /can't run fully offline/);
});

test("a service the code needs that the docs never mention; Compose or docs make it fine", () => {
  const base = { ...APP, "package.json": APP["package.json"].replace('"pg": "8"', '"pg": "8", "ioredis": "5"'), "src/q.ts": "new Redis(process.env.REDIS_URL);\nconnect(process.env.DATABASE_URL);" };
  const missing = find(run(repo({ ...base, "README.md": "Run `npm run dev`." })), "services.missing")!;
  assert.match(missing.text, /PostgreSQL.*Redis/);
  assert.equal(missing.priority, "important"); // undocumented isn't proven missing
  const composed = run(repo({ ...base, "README.md": "Start services with `docker compose up -d`.", "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n    volumes:\n      - data:/var/lib/postgresql/data\n  cache:\n    image: redis:7\n" }));
  assert.equal(find(composed, "services.missing"), undefined);
  assert.match(find(composed, "services.ok")!.text, /PostgreSQL \(started by docker-compose\.yml\)/);
  // A client library alone (an integration platform lists dozens) isn't proof it's needed.
  assert.equal(find(run(repo({ ...APP, "package.json": APP["package.json"].replace('"pg": "8"', '"mongodb": "6"'), "README.md": "x" })), "services.missing"), undefined);
});

test("migrations nobody runs, and a database without a volume", () => {
  const files = repo({ ...APP, "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}', "README.md": "Install Postgres, then `npm run dev`.", "docker-compose.yml": "services:\n  postgres:\n    image: postgres:16\n" }, ["prisma/migrations/0001_init/migration.sql"]);
  const all = run(files);
  assert.equal(find(all, "setup.migrations")!.level, "risk");
  assert.match(find(all, "setup.migrations")!.action!, /prisma migrate deploy/);
  assert.match(find(all, "deploy.volumes")!.text, /without a volume/);
  const ok = run(repo({ ...files.files, "README.md": "Then run `npx prisma migrate dev`." }, files.paths));
  assert.equal(find(ok, "setup.migrations")!.status, "pass");
});

test("checks fit the kind of project: a CLI isn't asked for health checks or backups", () => {
  const cli = repo({ "package.json": JSON.stringify({ name: "fmt", bin: { fmt: "bin/fmt.js" }, dependencies: { commander: "12" } }), "bin/fmt.js": "#!/usr/bin/env node", "README.md": "`npx fmt file.js`" });
  assert.equal(projectKind(cli).kind, "cli");
  const all = run(cli);
  assert.equal(all.filter((x) => x.section === "deploy").length, 0);
  assert.match(find(all, "setup.na")!.text, /deployment, health checks and backups/);
  assert.equal(find(all, "setup.na")!.status, "n/a");
  assert.equal(projectKind(repo({ "package.json": JSON.stringify({ name: "lib", main: "index.js" }), "index.js": "module.exports = 1", "test.js": "" })).kind, "library");
  assert.equal(projectKind(repo({ "README.md": "# Awesome things\n- [a](b)" })).kind, "docs");
});

test("secrets: real-looking keys are reported with only a few characters shown; dummies and patterns aren't", () => {
  const live = "AKIA" + "Q3EGRZ7XWJP5N2KD";
  const files = repo({
    "src/config.js": `const aws = "${live}";\nconst gh = "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";`,
    "src/redact.ts": "const PEM = /-----BEGIN PRIVATE KEY-----[\\s\\S]+?-----END PRIVATE KEY-----/;",
    "test/keys.ts": `export const k = "${"AKIA" + "ZZ3EGRZ7XWJP5N2K"}";`,
    "README.md": `Set AWS_ACCESS_KEY_ID=${"AKIA" + "IOSFODNN7EXAMPLE"}`,
    ".env.production": `VITE_FIREBASE_KEY=AIza${"SyD3x9Qm2LkP7wZr4TbVn8cHjF6aGeYo1uE"}`,
  });
  const hits = secrets(files);
  const real = hits.filter((h) => !h.test && !h.public);
  assert.deepEqual(real.map((h) => [h.what, h.path, h.line, h.shown]), [["an AWS access key", "src/config.js", 1, "AKIA…"]]);
  assert.ok(hits.some((h) => h.public) && hits.some((h) => h.test));
  const found = find(run(files), "secrets.found")!;
  assert.equal(found.status, "concern");
  assert.doesNotMatch(found.text, new RegExp(live));
});

test("tests existing isn't tests passing: CI results are reported for the commit", () => {
  const files = repo({ ...APP, "package.json": APP["package.json"].replace('"start": "next start"', '"start": "next start", "test": "vitest"'), ".github/workflows/ci.yml": "jobs:\n  t:\n    steps:\n      - run: npm test\n" }, ["src/a.test.ts", "src/b.test.ts"]);
  const ci = { source: "commit" as const, runs: [{ name: "test", conclusion: "failure", url: "u1" }, { name: "build", conclusion: "success", url: "u2" }] };
  const all = run(files, facts({ ci }));
  assert.match(find(all, "tests.present")!.text, /2 test files, run with npm test/);
  assert.equal(find(all, "tests.ci"), undefined);
  const r = find(all, "tests.result")!;
  assert.equal(r.kind, "reported");
  assert.match(r.text, /1 of 2 checks failing on the inspected commit: test/);
});

test("commands are read from shell blocks only, following cd, and skipping console output", () => {
  const files = repo({ "README.md": "```js\nnpm run nope\n```\n```console\n$ cd web\n$ npm run dev\nready on :3000\n```\n" });
  const c = commands(files, "tool");
  assert.deepEqual(c.map((x) => [x.raw, x.cwd]), [["npm run dev", "web"]]);
});

test("the repo archive is unpacked in memory: text kept, binaries and vendored code listed but not read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gm-tar-"));
  const root = join(dir, "acme-tool-abc123");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "node_modules/x"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# Tool");
  writeFileSync(join(root, "src", `${"long-name-".repeat(12)}.ts`), "export {}");
  writeFileSync(join(root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
  writeFileSync(join(root, "node_modules/x/index.js"), "x");
  execFileSync("tar", ["-czf", join(dir, "a.tgz"), "-C", dir, "acme-tool-abc123"], { env: { ...process.env, COPYFILE_DISABLE: "1" } }); // no macOS ._ files
  const raw = gunzipSync(readFileSync(join(dir, "a.tgz")));
  const snap = await untar((async function* () { for (let i = 0; i < raw.length; i += 700) yield raw.subarray(i, i + 700); })(), { stripFirst: true });
  assert.equal(snap.files["README.md"], "# Tool");
  assert.ok(Object.keys(snap.files).some((p) => p.startsWith("src/long-name-")));
  assert.ok(snap.paths.includes("logo.png") && snap.paths.includes("node_modules/x/index.js"));
  assert.equal(snap.files["logo.png"], undefined);
  assert.deepEqual(snap.skipped.map((s) => s.reason).sort(), ["images, media and other binary files", "vendored or built folders"]);
});

test("when only the main files were read, a missing script is a question, not a blocker", () => {
  const files: Files = {
    files: { ...APP, "README.md": "```bash\nnpm install\nnpm run seed-app-store\n```\n" },
    paths: [...Object.keys(APP), "README.md", "apps/web/package.json", "packages/db/package.json"],
    whole: false,
  };
  const x = find(run(files), "setup.scripts")!;
  assert.equal(x.priority, "important");
  assert.match(x.title, /not found in the manifests read/);
  assert.match(x.text, /package\.json, the only package\.json read, doesn't define it\. The repo has 3 package\.json files/);
});

test("deployment needs a guide, not a word; container and health check claim only what was seen", () => {
  const app = { ...APP, "docker-compose.yml": "services:\n  web:\n    build: .\n" };
  const word = run(repo({ ...app, "README.md": "# Tool\n\nYou can self-host it.\n" }));
  assert.equal(find(word, "deploy.docs")!.status, "info");
  assert.equal(find(word, "deploy.docs")!.title, "Deployment mentioned, no guide");
  const guide = run(repo({ ...app, "README.md": "# Tool\n\n## Deploying to production\n\nRun docker compose up.\n" }));
  assert.equal(find(guide, "deploy.docs")!.status, "pass");
  assert.match(find(guide, "deploy.container")!.text, /Building and starting it weren't checked/);
  assert.match(find(guide, "deploy.health")!.text, /No explicit health check/);
});

test("settings the code sets, only checks, or that belong to the OS aren't counted; driver and switched keys are optional", () => {
  const files = repo({
    ...APP,
    ".env.example": "DATABASE_URL=\n",
    "src/main.py": 'import os\nos.environ["OMP_THREAD_LIMIT"] = "1"\nos.environ["MY_FLAG"] = "1"\nif os.environ.get("X"): pass\n',
    "src/icons.ts": "const theme = process.env.ICON_THEME ? load(process.env.ICON_THEME) : 'hicolor';\nconst home = process.env.HOMEPATH;",
    "src/google.ts": 'if (process.env.NEXT_PUBLIC_GOOGLE_ENABLED !== "true") return;\nconst id = process.env.GOOGLE_CLIENT_SECRET;',
    "update-readme.js": "if (process.env.PRINT_ENV) console.log(1);",
    "README.md": "Copy `.env.example`.",
  });
  const reads = envReads(files);
  const names = reads.map((r) => r.name);
  assert.ok(!names.includes("MY_FLAG") && !names.includes("OMP_THREAD_LIMIT") && !names.includes("HOMEPATH") && !names.includes("PRINT_ENV"));
  assert.equal(reads.find((r) => r.name === "ICON_THEME")!.fallback, true);
  const acct = find(run(files), "services.accounts");
  assert.ok(!acct || acct.priority === undefined, "a key behind an _ENABLED switch is optional");
});

test("steps from contributor docs, other repos, placeholders and files the docs say to create aren't blockers", () => {
  const files = repo({
    ...APP,
    "README.md": "# Tool\n\n```bash\nnpm install\nnpm run dev\n```\n\n## Development\n\n```bash\nnpm run bench\n```\n\nRun any script with `npm run [script]`.\n",
    "CONTRIBUTING.md": "```bash\ngit clone https://github.com/microsoft/playwright\ncd playwright\nnpm run watch\n```\n",
    "docs/docker.md": "Create a `docker-compose.yml`:\n\n```yaml\nservices:\n  app:\n    image: tool\n```\n\n```bash\ndocker compose up -d\n```\n",
  });
  const all = run(files);
  const scripts = find(all, "setup.scripts")!;
  assert.match(scripts.title, /contributor docs/);
  assert.equal(scripts.priority, "improvement");
  assert.doesNotMatch(scripts.text, /watch|\[script\]/);
  assert.equal(find(all, "setup.files"), undefined);
});

test("public client keys and test keys aren't reported as leaks", () => {
  // Built from pieces so this file never holds a whole key: GitHub's secret scanning would flag it on push.
  const google = "AIza" + "SyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"; // YouTube's public web client key
  const pem = "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH " + "PRIVATE KEY-----";
  const gh = "ghp_" + "R2kkVxN31PiqsJYXFmTIBmOu5a9gM0042muH"; // made up for this test
  const hits = secrets(repo({
    "yt_dlp/extractor/youtube.py": `INNERTUBE_API_KEY = "${google}"`,
    "database/seeders/PrivateKeySeeder.php": `'private_key' => '${pem}',`,
    "crates/common/src/secrets.rs": `#[cfg(test)]\nmod tests {\n  const T: &str = "${gh}"; // legit, I expired it\n}`,
  }));
  assert.ok(hits.length >= 2);
  assert.ok(hits.every((h) => h.test || h.public), JSON.stringify(hits));
});

test("project kind: examples don't decide it; Electron, GUI crates, published packages and templates do", () => {
  const kind = (files: Record<string, string>, extra: string[] = [], repo: Partial<Facts["repo"]> = {}) =>
    projectKind(repo_(files, extra), undefined, { repo: { fullName: `acme/${repo.fullName ?? "tool"}`, topics: [], description: null, ...repo } as never }).kind;
  const repo_ = (files: Record<string, string>, extra: string[] = []) => ({ files, paths: [...Object.keys(files), ...extra], whole: true });
  // Flask: the web framework only appears in its examples.
  assert.equal(kind({ "pyproject.toml": '[project]\nname = "flask"\nclassifiers = ["Framework :: Flask"]\ndependencies = ["werkzeug>=3"]', "src/flask/app.py": "x", "examples/celery/pyproject.toml": '[project]\ndependencies = ["flask"]' }, [], { fullName: "flask" }), "library");
  // lossless-cut: Electron as a dev dependency, express too.
  assert.equal(kind({ "package.json": '{"name":"lossless-cut","dependencies":{"express":"4"},"devDependencies":{"electron":"30"}}', "src/main.ts": "x", "src/a.ts": "x", "src/b.ts": "x" }), "desktop");
  // Alacritty: a Cargo workspace whose binary crate uses winit.
  assert.equal(kind({ "Cargo.toml": "[workspace]\nmembers = ['alacritty']", "alacritty/Cargo.toml": '[package]\nname = "alacritty"\n[dependencies]\nwinit = "0.30"', "alacritty/src/main.rs": "fn main(){}", "alacritty/src/a.rs": "", "alacritty/src/b.rs": "" }, [], { fullName: "alacritty" }), "desktop");
  // Zellij: a CLI whose server crate uses axum.
  assert.equal(kind({ "Cargo.toml": '[package]\nname = "zellij"\n[dependencies]\nclap = "4"', "src/main.rs": "fn main(){}", "zellij-server/Cargo.toml": '[dependencies]\naxum = "0.7"', "zellij-server/src/a.rs": "", "zellij-server/src/b.rs": "" }, [], { fullName: "zellij" }), "cli");
  // A template marked on GitHub, and a skills collection.
  assert.equal(kind({ "package.json": '{"dependencies":{"next":"15"}}', "a.ts": "", "b.ts": "", "c.ts": "" }, [], { isTemplate: true }), "template");
  assert.equal(kind({ "README.md": "x" }, ["skills/docx/SKILL.md", ".claude-plugin/marketplace.json"]), "plugin");
});

test("migrations: run at startup, by install scripts or a Rails entrypoint pass; an example's don't count", () => {
  const goose = run(repo({ "go.mod": "module x\nrequire github.com/go-chi/chi/v5 v5.0.0\nrequire github.com/lib/pq v1.0.0", "main.go": "package main", "db/db.go": "goose.UpContext(ctx, db, \"migrations\")", "db/migrations/0001_init.sql": "create table x();", "Dockerfile": "FROM golang", "README.md": "Run it." }));
  assert.notEqual(find(goose, "setup.migrations")?.priority, "blocker");
  const laravel = run(repo({ "composer.json": JSON.stringify({ require: { "laravel/framework": "^11" }, scripts: { "post-create-project-cmd": ["@php artisan migrate --graceful --ansi"] } }), "database/migrations/0001_users.php": "<?php", "app/a.php": "", "app/b.php": "", "README.md": "x" }));
  assert.notEqual(find(laravel, "setup.migrations")?.priority, "blocker");
  const example = run(repo({ ...APP, "examples/with-edgedb/dbschema/migrations/00001.edgeql": "x", "README.md": "x" }));
  assert.equal(find(example, "setup.migrations"), undefined);
});

test("placeholder passwords shipped to be changed are flagged for apps and templates", () => {
  const all = run(repo({ ...APP, ".env": "SECRET_KEY=changethis\nPOSTGRES_PASSWORD=changethis\nDOMAIN=localhost\n", "README.md": "x" }));
  const x = find(all, "secrets.placeholders")!;
  assert.equal(x.priority, "important");
  assert.match(x.text, /SECRET_KEY and POSTGRES_PASSWORD/);
});

test("a project's own .claude/skills folder doesn't make it a plugin; paths after git clone start in the clone", () => {
  const app = { ...APP, "docker-compose.yml": "services:\n  web:\n    build: .\n", "README.md": "x" };
  assert.equal(projectKind(repo(app, [".claude/skills/review/SKILL.md"]), undefined, { repo: { fullName: "acme/tool", topics: [], description: null } as never }).kind, "app");
  const leanrea = run(repo({ "README.md": "```sh\ngit clone https://github.com/acme/tool\nmkdir -p ~/.claude/skills && cp -R tool/skill ~/.claude/skills/\n```\n", "skill/SKILL.md": "x" }));
  assert.equal(find(leanrea, "setup.files"), undefined);
});

test("the setup path follows one documented route, with the checks about each step", () => {
  const out = setupFindings({
    facts: facts(),
    files: repo({
      ...APP,
      ".env.example": "DATABASE_URL=\n",
      "README.md": "# Tool\n\n## Quick start\n\n```bash\ngit clone https://github.com/acme/tool\ncd tool\nnpm install\ncp .env.example .env\nnpm run dev\n```\n\n## Without Docker\n\n```bash\nnpm ci\nnpm start\n```\n",
    }),
    link: (p) => p,
  });
  assert.deepEqual(out.steps.map((s) => [s.phase, s.command]), [["get", "git clone https://github.com/acme/tool"], ["install", "npm install"], ["configure", "cp .env.example .env"], ["run", "npm run dev"]]);
  assert.equal(out.steps[0].line, 6);
});

import assert from "node:assert/strict";
import { test } from "node:test";

test("a numbered list of inline commands becomes steps, with where each runs", async () => {
  const { listSteps } = await import("../lib/readme.ts");
  const md = `1. \`scripts/vm-xnu-build.sh\` (on the arm64 Linux host, once): sets up the toolchain and builds XNU
   natively on arm64.
2. \`scripts/mk-macvm-disk.sh\` (on the Mac): turns a macOS VM disk into the system disk.
3. Run \`make install\` to install it.`;
  assert.deepEqual(listSteps(md), [
    { command: "scripts/vm-xnu-build.sh", where: "on the arm64 Linux host, once", text: "sets up the toolchain and builds XNU natively on arm64." },
    { command: "scripts/mk-macvm-disk.sh", where: "on the Mac", text: "turns a macOS VM disk into the system disk." },
    { command: "make install", where: null, text: "to install it." },
  ]);
});

test("not steps: feature lists, FAQs, a single command, code that isn't a command", async () => {
  const { listSteps } = await import("../lib/readme.ts");
  assert.deepEqual(listSteps("1. Fast and small\n2. Works offline\n3. `--verbose` prints more"), []);
  assert.deepEqual(listSteps("1. Why is it slow? Use `--cache`.\n2. Where are files? In `~/.tool`."), []);
  assert.deepEqual(listSteps("1. `npm install`\n\nThen read the docs."), []);
  assert.deepEqual(listSteps("1. `config.yaml` holds the settings\n2. `MAX_SIZE` limits uploads"), []);
});

test("a kernel module makes it involved; a Korean README link doesn't", async () => {
  const { analyze } = await import("../lib/detect.ts");
  const run = (readme: string) => analyze({ owner: "a", repo: "b" }, { "README.md": readme }, new Set(["README.md"]), ["README.md"], null, null);
  assert.equal(run("# Tool\n[한국어](README.ko.md) · [Support me](https://ko-fi.com/x)").difficulty.label, "Easy");
  const mod = run("# Driver\n\n## Building and running\n\n1. `make` builds `driver.ko`.\n2. `sudo insmod driver.ko` loads it.");
  assert.equal(mod.difficulty.label, "Involved");
  assert.ok(mod.hints.some((h) => h.startsWith("It loads a kernel module")));
});

test("a project that only talks about kernel modules isn't one", async () => {
  const { analyze } = await import("../lib/detect.ts");
  const r = analyze({ owner: "a", repo: "b" }, { "README.md": "# Prompts\n\n```text\nUse REA on <kernel module / driver>.\n```" }, new Set(["README.md"]), ["README.md"], null, null);
  assert.ok(!r.hints.some((h) => h.startsWith("It loads a kernel module")));
});

test("the .env example to copy: the plain one first, test and special-purpose ones last", async () => {
  const { analyze } = await import("../lib/detect.ts");
  const pick = (names: string[]) => {
    const files = Object.fromEntries([["README.md", "# T"], ...names.map((n) => [n, "PORT=3000\n"])]);
    const a = analyze({ owner: "a", repo: "b" }, files, new Set(Object.keys(files)), Object.keys(files), null, null);
    return a.steps.linux.find((s) => s.title === "Configure environment variables")?.commands[0];
  };
  assert.equal(pick([".env.dusk.example", ".env.test.example", ".env.example"]), "cp .env.example .env");
  assert.equal(pick([".env.dev-oci.example", ".env.test.example", ".env.dev-azure.example", ".env.dev.example", ".env.prod.example"]), "cp .env.dev.example .env");
  assert.equal(pick([".env.ai-surfaces.example", ".env.local.example"]), "cp .env.local.example .env");
});

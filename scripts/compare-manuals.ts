// Compares what two versions of the code say about hundreds of real repos, before a change to how manuals are
// built goes live. For each repo in scripts/compare-repos.json it builds the manual twice, with the code at --base
// (default: the last commit) and with the working tree, and reports every difference in steps, difficulty, the
// "Will it work?" answers (including for an x86-64 and an arm64 Linux visitor), the processor it needs and the setup
// scripts offered. Read the report: each change should be an improvement, or the rule needs tightening.
//
//   GITHUB_TOKEN=… npx tsx scripts/compare-manuals.ts [--base <git ref>] [--limit 50] [--only owner/repo,owner/repo]
//
// Safe to run anywhere: it never uses the real database (each side gets its own throwaway file under .cache/), never
// calls Claude or sends email, and reads GitHub through a cache in .cache/compare/github, so both sides see exactly the
// same files and a second run needs no network at all. Delete that folder to read GitHub afresh.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = join(ROOT, ".cache", "compare");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

type Summary = {
  error?: string;
  difficulty?: { label: string; score: number };
  scripts?: string[];
  steps?: Record<string, string[]>;
  headline?: Record<string, string>;
  linuxX64?: string;
  linuxArm?: string;
  cpu?: { arch: string; os: string | null; quote: string } | null;
};

// ---- One side: build every repo with one copy of lib/ and write a summary (run as a child process) ----
async function side(name: string, lib: string, repos: string[]) {
  // Never the real database, never Claude, never email.
  process.env.TURSO_DATABASE_URL = `file:${join(CACHE, `${name}.db`)}`;
  process.env.TURSO_AUTH_TOKEN = "";
  process.env.SUMMARIES = "off";
  for (const k of ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "ADMIN_EMAIL", "STRIPE_SECRET_KEY"]) delete process.env[k];
  rmSync(join(CACHE, `${name}.db`), { force: true });

  // GitHub through a disk cache: the same answers for both sides, and no network the second time.
  const realFetch = globalThis.fetch;
  const dir = join(CACHE, "github");
  mkdirSync(dir, { recursive: true });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!/^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(url)) return realFetch(input, init);
    const file = join(dir, `${createHash("sha1").update(url).digest("hex")}.json`);
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf8"));
      return new Response(c.body, { status: c.status, headers: { "content-type": c.type ?? "text/plain" } });
    }
    const res = await realFetch(input, init);
    const body = await res.text();
    if (res.status !== 403 && res.status !== 429) writeFileSync(file, JSON.stringify({ status: res.status, body, type: res.headers.get("content-type") }));
    return new Response(body, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/plain" } });
  }) as typeof fetch;

  const { loadRepo } = await import(join(lib, "pipeline.ts"));
  const { fitCheck } = await import(join(lib, "fit.ts"));
  const out: Record<string, Summary> = {};
  const systems = ["mac", "windows", "linux"];
  let done = 0;
  for (const full of repos) {
    const [owner, repo] = full.split("/");
    try {
      const { data } = await loadRepo({ owner, repo }, { fresh: true });
      const a = data.analysis;
      const fit = (os: string, arch: string | null) => fitCheck(a, data.install, os, arch, data.meta.archived);
      out[full] = {
        difficulty: a.difficulty,
        scripts: data.guides.scripts.map((s: { path: string }) => s.path),
        steps: Object.fromEntries(systems.map((os) => [os, a.steps[os].map((s: { title: string; commands: string[] }) => `${s.title} :: ${s.commands.join(" ; ")}`)])),
        headline: Object.fromEntries(systems.map((os) => [os, `${fit(os, null).status}: ${fit(os, null).headline}`])),
        linuxX64: `${fit("linux", "x64").status}: ${fit("linux", "x64").headline}`,
        linuxArm: `${fit("linux", "arm64").status}: ${fit("linux", "arm64").headline}`,
        cpu: a.cpu ?? null,
      };
    } catch (e) {
      out[full] = { error: e instanceof Error ? e.message : String(e) };
    }
    if (++done % 50 === 0) console.error(`  ${name}: ${done}/${repos.length}`);
  }
  writeFileSync(join(CACHE, `${name}.json`), JSON.stringify(out));
}

// ---- The report ----
function report(base: Record<string, Summary>, head: Record<string, Summary>, baseRef: string): string {
  const lines: string[] = [];
  let changed = 0;
  for (const repo of Object.keys(head)) {
    const b = base[repo] ?? {};
    const h = head[repo];
    const d: string[] = [];
    if (b.error !== h.error) d.push(`error: ${b.error ?? "none"} → ${h.error ?? "none"}`);
    if (JSON.stringify(b.difficulty) !== JSON.stringify(h.difficulty)) d.push(`difficulty: ${b.difficulty?.label} (${b.difficulty?.score}) → ${h.difficulty?.label} (${h.difficulty?.score})`);
    for (const os of ["mac", "windows", "linux"]) if (b.headline?.[os] !== h.headline?.[os]) d.push(`will it work, ${os}: ${b.headline?.[os]} → ${h.headline?.[os]}`);
    if (b.linuxX64 !== h.linuxX64) d.push(`will it work, linux x86-64 visitor: ${b.linuxX64} → ${h.linuxX64}`);
    if (b.linuxArm !== h.linuxArm) d.push(`will it work, linux arm64 visitor: ${b.linuxArm} → ${h.linuxArm}`);
    if (JSON.stringify(b.cpu ?? null) !== JSON.stringify(h.cpu ?? null)) d.push(`processor: ${b.cpu ? `${b.cpu.arch}` : "none"} → ${h.cpu ? `${h.cpu.arch}${h.cpu.os ? ` on ${h.cpu.os}` : ""} “${h.cpu.quote}”` : "none"}`);
    if (JSON.stringify(b.scripts) !== JSON.stringify(h.scripts)) d.push(`scripts: ${b.scripts?.join(", ") || "none"} → ${h.scripts?.join(", ") || "none"}`);
    for (const os of ["mac", "windows", "linux"]) {
      const bs = b.steps?.[os] ?? [];
      const hs = h.steps?.[os] ?? [];
      if (JSON.stringify(bs) === JSON.stringify(hs)) continue;
      d.push(`steps (${os}):\n${bs.filter((x) => !hs.includes(x)).map((x) => `      − ${x}`).join("\n")}\n${hs.filter((x) => !bs.includes(x)).map((x) => `      + ${x}`).join("\n")}`);
    }
    if (d.length) {
      changed++;
      lines.push(`\n## ${repo}\n${d.map((x) => `  - ${x}`).join("\n")}`);
    }
  }
  return `# Manuals: ${baseRef} → working tree\n\n${changed} of ${Object.keys(head).length} repos changed.\n${lines.join("\n")}\n`;
}

async function main() {
  const sideName = arg("side");
  const listFile = arg("repos") ?? join(ROOT, "scripts", "compare-repos.json");
  let repos: string[] = JSON.parse(readFileSync(listFile, "utf8")).repos;
  if (arg("only")) repos = arg("only")!.split(",");
  if (arg("limit")) repos = repos.slice(0, Number(arg("limit")));
  if (sideName) return side(sideName, arg("lib")!, repos);

  const baseRef = arg("base") ?? "HEAD";
  mkdirSync(CACHE, { recursive: true });
  // The base side's code: lib/ as it was at --base, next to node_modules so its imports resolve.
  const baseDir = join(ROOT, ".cache", "compare-base");
  rmSync(baseDir, { recursive: true, force: true });
  mkdirSync(baseDir, { recursive: true });
  execFileSync("sh", ["-c", `git archive ${JSON.stringify(baseRef)} lib | tar -x -C ${JSON.stringify(baseDir)}`], { cwd: ROOT, stdio: "inherit" });
  const run = (name: string, lib: string) =>
    new Promise<void>((done, fail) => {
      const extra = ["--repos", listFile, ...(arg("only") ? ["--only", arg("only")!] : []), ...(arg("limit") ? ["--limit", arg("limit")!] : [])];
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--side", name, "--lib", lib, ...extra], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
      child.on("exit", (code) => (code === 0 ? done() : fail(new Error(`${name} side exited with ${code}`))));
    });
  console.error(`Building ${repos.length} manuals with ${baseRef} (fills the GitHub cache the first time)…`);
  await run("base", join(baseDir, "lib"));
  console.error("Building them with the working tree…");
  await run("head", join(ROOT, "lib"));
  rmSync(baseDir, { recursive: true, force: true });
  const text = report(JSON.parse(readFileSync(join(CACHE, "base.json"), "utf8")), JSON.parse(readFileSync(join(CACHE, "head.json"), "utf8")), baseRef);
  const out = join(CACHE, "report.md");
  writeFileSync(out, text);
  console.error(`${text.split("\n")[2]}\nReport: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

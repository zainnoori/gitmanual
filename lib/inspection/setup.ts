import { ownNames, type Facts } from "./collect";
import type { Evidence, Finding, ProjectKind, SetupStep, StepPhase } from "./types";

// "Before you run it": what a repo's docs say against what its files show. Plain rules over the whole repo at one
// commit (archive.ts). Every finding points at the file and line it comes from, and anything not found is worded as
// "not found in the files read". Checks that don't fit the kind of project (a library has no deployment) are skipped
// and listed as not applicable, never counted against it.

export type Files = { files: Record<string, string>; paths: string[]; whole: boolean };

const lines = (text: string, index: number) => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 4) => {
  const shown = xs.slice(0, max);
  const more = xs.length - shown.length;
  const body = shown.length < 3 && !more ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")}${more ? `, ${shown.at(-1)}` : ` and ${shown.at(-1)}`}`;
  return more ? `${body} and ${more} more` : body;
};
const norm = (x: string) => x.toLowerCase().replace(/^@[^/]+\//, "").replace(/[-_.]+/g, "-");
const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, rel: string): string | null => {
  const parts = dir ? dir.split("/") : [];
  for (const seg of rel.replace(/^\.\//, "").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
};
const json = (t: string | undefined): any => {
  try {
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
};

// ── Which files are what ──────────────────────────────────────────────────────────────────────────────────────────
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|py|go|rs|rb|php|java|kt|kts|scala|cs|fs|ex|exs|vue|svelte|astro|swift|dart|lua|cr|nim|zig|c|cc|cpp|h|hpp)$/i;
const NOT_APP_CODE = /(^|\/)(\.[^/]+|tests?|__tests__|__mocks__|specs?|e2e|cypress|playwright|fixtures?|testdata|[\w-]*examples?[\w-]*|samples?|demos?|docs?|benchmarks?|bench|stories|\.storybook|\.github|scripts?|tools?|hack|contrib)\/|\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)(test_[^/]+|conftest)\.py$|Tests?\.(cs|java|kt)$|(^|\/)(vitest|jest|playwright|karma|cypress|vite|webpack|rollup|eslint|babel|tsup|esbuild)[\w.-]*\.(config|setup)[\w.-]*$|\.(setup|config)\.[cm]?[jt]s$/i;
const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e|cypress|playwright)\/[^/]+\.\w+$|(^|\/)tests?\.([cm]?[jt]s|py)$|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|exs)$|(^|\/)test_[^/]+\.py$|(Test|Tests|Spec)\.(cs|java|kt|scala|swift)$|_spec\.rb$|\.bats$/i;
const DOC = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
// Code for optional integrations (connectors, plugins, providers): what it reads isn't needed to start the project.
const INTEGRATION = /(^|\/)(nodes|integrations?|providers?|plugins?|adapters?|connectors?|extensions?|credentials|contrib|community)(\/|[-_][\w-]*\/)/i;
const byDepth = (a: string, b: string) => a.split("/").length - b.split("/").length || a.length - b.length;
const SETUP_DOC = /^((\.github|docs?|documentation)\/)?(README|INSTALL(ATION)?|SETUP|GETTING[-_ ]?STARTED|QUICK[-_ ]?START|CONTRIBUTING|DEVELOP(MENT|ING)?|HACKING|BUILD(ING)?|SELF[-_ ]?HOST(ING)?|DEPLOY(MENT|ING)?|RUNNING)(\.[\w-]+)?\.(md|mdx|markdown|rst|txt)$|^(docs?|documentation)\/(.+\/)?[^/]*(install|setup|getting[-_]?started|quick[-_]?start|self[-_]?host|deploy|development|configur|running|docker|requirements|prerequisites)[^/]*\.(md|mdx|rst|txt)$/i;
const ENV_EXAMPLE = /(^|\/)(\.env(\.[\w-]+)*\.(example|sample|template|dist|defaults|tmpl|tpl|default)|(example|sample|template)\.env|env\.(example|sample|template)|\.env\.defaults|[\w-]+\.env\.example)$/i;
const COMPOSE = /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;
const DOCKERFILE = /(^|\/)(Dockerfile|Containerfile)(\.[\w-]+)?$|\.Dockerfile$/i;
const MAKEFILE = /(^|\/)(GNUmakefile|[Mm]akefile)$/;
// Anything that isn't code and may document a setting: docs, config, settings files, scripts.
const CONFIG = /\.(md|mdx|markdown|rst|txt|adoc|ya?ml|toml|json|jsonc|json5|ini|cfg|conf|env|properties|tf|hcl|nix|sh|bash|ps1|xml|example|sample|template|dist)$|(^|\/)(Dockerfile[^/]*|Containerfile|Procfile|Makefile|\.env[^/]*|[\w.-]*\.env[\w.-]*)$/i;

// Translated copies of the docs (docs/de/…, i18n/…): the English ones say the same thing.
const TRANSLATED = /(^|\/)(i18n|translations?|locales?)\/|(^|\/)docs?\/(?!en\/)([a-z]{2}([-_][A-Za-z]{2,4})?)\//;
function docsOf(f: Files) {
  const english = Object.keys(f.files).some((p) => /^README\.(md|mdx|markdown|rst)$/i.test(p));
  return Object.keys(f.files)
    .filter((p) => SETUP_DOC.test(p) && !(english && /(^|\/)README[._-](?!md\b)[A-Za-z]{2,3}([-_][A-Za-z]{2,4})?\.(md|mdx|markdown|rst|txt)$/i.test(p)) && !TRANSLATED.test(p))
    .sort((a, b) => a.split("/").length - b.split("/").length || (/^README/i.test(a) ? -1 : /^README/i.test(b) ? 1 : a.localeCompare(b)))
    .slice(0, 30);
}

// ── The repo's own dependencies, from its manifests (direct ones only) ────────────────────────────────────────────
export type Dep = { file: string; dev: boolean; line: number };
export function directDeps(f: Files): Map<string, Dep> {
  const out = new Map<string, Dep>();
  const put = (name: string, file: string, dev: boolean, index: number, text: string) => {
    const key = name.toLowerCase().replace(/\[.*\]$/, "");
    const had = out.get(key);
    // The main app's manifest names a dependency better than a docs site's or an example's does.
    const minor = (p: string) => /(^|\/)(docs?|examples?|website|playground|fixtures?)(\/|$)/i.test(p);
    if (!had || (had.dev && !dev) || (had.dev === dev && minor(had.file) && !minor(file))) out.set(key, { file, dev, line: lines(text, index) });
  };
  for (const [p, t] of Object.entries(f.files)) {
    const base = p.split("/").pop()!;
    if (base === "package.json") {
      const j = json(t);
      if (!j) continue;
      for (const [field, dev] of [["dependencies", false], ["optionalDependencies", false], ["devDependencies", true]] as const)
        for (const name of Object.keys(j[field] ?? {})) put(name, p, dev, Math.max(0, t.indexOf(`"${name}"`)), t);
    } else if (/^requirements[\w.-]*\.(txt|in)$/i.test(base)) {
      // Next to a pyproject.toml that lists its own dependencies, requirements files pin the dev and docs tools (httpx).
      const dev = /dev|test|lint|doc/i.test(base) || /^\s*dependencies\s*=\s*\[/m.test(f.files[join(dirOf(p), "pyproject.toml") ?? "pyproject.toml"] ?? "");
      for (const m of t.matchAll(/^\s*([A-Za-z0-9][A-Za-z0-9_.\-]*)(\[[^\]]*\])?\s*(?:[<>=!~;@ ]|$)/gm)) put(m[1], p, dev, m.index!, t);
    } else if (base === "pyproject.toml") {
      for (const block of t.matchAll(/^\s*(dependencies|[\w-]+)\s*=\s*\[([\s\S]*?)\]/gm)) {
        if (block[1] !== "dependencies" && !/optional-dependencies|dependency-groups/.test(t.slice(Math.max(0, block.index! - 400), block.index!))) continue;
        const dev = block[1] !== "dependencies" && /dev|test|lint|doc/i.test(block[1]);
        for (const m of block[2].matchAll(/["']\s*([A-Za-z0-9][A-Za-z0-9_.\-]*)/g)) put(m[1], p, dev, block.index! + (m.index ?? 0), t);
      }
      for (const sec of t.matchAll(/^\[tool\.poetry\.(dependencies|group\.([\w-]+)\.dependencies|dev-dependencies)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm)) {
        const dev = sec[1] !== "dependencies";
        for (const m of sec[3].matchAll(/^([A-Za-z0-9][A-Za-z0-9_.\-]*)\s*=/gm)) if (m[1].toLowerCase() !== "python") put(m[1], p, dev, sec.index! + (m.index ?? 0), t);
      }
    } else if (base === "go.mod") {
      for (const m of t.matchAll(/^\s*(?:require\s+)?([\w.\-]+\.[\w.\-/]+)\s+v[\w.\-+]+(\s*\/\/\s*indirect)?/gm)) if (!m[2]) put(m[1], p, false, m.index!, t);
    } else if (base === "Cargo.toml") {
      // [workspace.dependencies] only declares versions for the member crates; it isn't a use.
      for (const sec of t.matchAll(/^\[((?:dev-|build-)?dependencies)\]\s*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm))
        for (const m of sec[2].matchAll(/^([A-Za-z0-9][\w-]*)\s*=/gm)) put(m[1], p, sec[1].includes("dev-"), sec.index! + (m.index ?? 0), t);
    } else if (base === "Gemfile") {
      for (const m of t.matchAll(/^\s*gem\s+['"]([\w\-]+)['"]/gm)) put(m[1], p, false, m.index!, t);
    } else if (base === "composer.json") {
      const j = json(t);
      for (const [field, dev] of [["require", false], ["require-dev", true]] as const) for (const name of Object.keys(j?.[field] ?? {})) put(name, p, dev, Math.max(0, t.indexOf(`"${name}"`)), t);
    }
  }
  return out;
}

// ── What kind of project ──────────────────────────────────────────────────────────────────────────────────────────
const WEB = ["next", "nuxt", "@remix-run/node", "@remix-run/react", "@sveltejs/kit", "express", "fastify", "koa", "hono", "@nestjs/core", "@hapi/hapi", "@adonisjs/core", "react-scripts", "vite", "@angular/core", "gatsby", "django", "flask", "fastapi", "starlette", "aiohttp", "tornado", "sanic", "litestar", "streamlit", "gradio", "rails", "sinatra", "laravel/framework", "symfony/framework-bundle", "github.com/gin-gonic/gin", "github.com/labstack/echo/v4", "github.com/gofiber/fiber/v2", "github.com/go-chi/chi/v5", "actix-web", "axum", "rocket", "warp", "phoenix"];
const FRONTEND_ONLY = new Set(["vite", "react-scripts", "@angular/core", "gatsby", "streamlit", "gradio"]);
const CLI_DEPS = ["commander", "yargs", "oclif", "@oclif/core", "cac", "meow", "clipanion", "click", "typer", "argparse", "fire", "clap", "structopt", "github.com/spf13/cobra", "github.com/urfave/cli/v2", "thor"];

// Examples, docs sites, tests and benchmarks don't say what the project is: Flask's examples use Flask as an app.
const MINOR_DIR = /(^|\/)(docs?|documentation|examples?|[\w-]*-examples?|samples?|demos?|website|site|playground|fixtures?|tests?|__tests__|e2e|benchmarks?|bench|templates?|scripts|tools|\.github)(\/|$)/i;
const GUI_CRATES = ["winit", "glutin", "egui", "eframe", "iced", "gtk", "gtk4", "relm4", "slint", "druid", "fltk", "tao", "wry", "gpui"];
const EXTENSION_DEPS = ["webextension-polyfill", "wxt", "plasmo", "@crxjs/vite-plugin", "webext-bridge", "@types/chrome", "@types/firefox-webext-browser"];

export function projectKind(f: Files, deps = directDeps(f), facts?: Pick<Facts, "repo">): { kind: ProjectKind; label: string; why: string } {
  const has = (re: RegExp) => f.paths.some((p) => re.test(p));
  const main = (d: Dep | undefined) => d && !MINOR_DIR.test(d.file);
  // A runtime dependency of the project itself; "any" also counts development ones (Electron usually is one).
  const dep = (names: string[], any = false) => names.find((n) => { const d = deps.get(n.toLowerCase()); return main(d) && (any || !d!.dev); });
  const pkg = json(f.files["package.json"]);
  const code = f.paths.filter((p) => CODE.test(p) && !/(^|\/)(node_modules|vendor)\//.test(p)).length;
  const name = facts?.repo.fullName.split("/")[1] ?? "";
  const manifest = f.paths.some((p) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?|CMakeLists\.txt|Makefile)$/.test(p));
  const containers = f.paths.some((p) => (DOCKERFILE.test(p) || COMPOSE.test(p)) && p.split("/").length <= 3 && !/(^|\/)\.[^/]+\//.test(p) && !MINOR_DIR.test(p));
  const text = `${facts?.repo.description ?? ""} ${(facts?.repo.topics ?? []).join(" ")}`;

  // Plugins and skills for AI coding tools, before "almost no code": they're mostly Markdown on purpose.
  // Only when that's the point of the repo: many projects keep .claude/skills or a plugin folder for their own tooling.
  const skills = f.paths.filter((p) => /(^|\/)SKILL\.md$/.test(p) && !/(^|\/)\.[^/]+\//.test(p));
  const pluginRoot = has(/^\.(claude|cursor)-plugin\//);
  if ((pluginRoot || skills.length) && code < 80 && !containers)
    return { kind: "plugin", label: "a plugin or skills for AI coding tools", why: pluginRoot ? "a .claude-plugin folder" : "SKILL.md files" };
  if ((code === 0 || (code < 3 && !manifest)) || /^awesome[-_]|[-_]awesome$/i.test(name) || facts?.repo.topics.includes("awesome-list"))
    return { kind: "docs", label: "a list or documentation", why: code < 3 ? "almost no code, mostly text files" : "an awesome list" };
  if (facts?.repo.isTemplate || /\b(starter|boilerplate|template|skeleton|scaffold)\b/i.test(name.replace(/[-_]/g, " ")))
    return { kind: "template", label: "a starter template", why: facts?.repo.isTemplate ? "marked as a template on GitHub" : "its name" };

  // A server with its own containers is an app, even when the repo also holds a mobile, desktop or browser
  // client (Immich, Linkwarden).
  const server = dep(WEB.filter((w) => !FRONTEND_ONLY.has(w)));
  const esc0 = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ownCrate = f.paths.find((p) => new RegExp(`^src\\/main\\.rs$|^(crates\\/)?${esc0}(-cli)?\\/src\\/main\\.rs$`, "i").test(p));
  const serverFile = server ? deps.get(server.toLowerCase())!.file : "";
  if (ownCrate && server && !(serverFile === "Cargo.toml" || serverFile === ownCrate.replace(/src\/main\.rs$/, "Cargo.toml")))
    return { kind: "cli", label: "a command-line tool", why: ownCrate };
  if (server && containers) return { kind: "app", label: "a web app or service", why: `${server} in ${deps.get(server.toLowerCase())!.file}, with a Dockerfile or Compose file` };

  // A browser extension: a manifest with manifest_version anywhere near the top, or an extension toolkit.
  const ext = Object.entries(f.files).find(([p, t]) => /(^|\/)manifest(\.[\w-]+)?\.json$/.test(p) && p.split("/").length <= 4 && !MINOR_DIR.test(p) && /"manifest_version"\s*:/.test(t));
  if (ext || dep(EXTENSION_DEPS, true)) return { kind: "extension", label: "a browser extension", why: ext ? ext[0] : `${dep(EXTENSION_DEPS, true)} in package.json` };

  // Desktop: Electron or Tauri (often development dependencies), a native GUI toolkit, Qt, or Compose Desktop.
  const desk = dep(["electron", "@tauri-apps/api", "@tauri-apps/cli", "tauri", "wails"], true) ?? dep(GUI_CRATES);
  const qt = Object.entries(f.files).find(([p, t]) => /(^|\/)CMakeLists\.txt$/.test(p) && p.split("/").length <= 3 && !MINOR_DIR.test(p) && /find_package\s*\(\s*Qt[56]?|Qt[56]?::(Widgets|Gui)|find_qt\s*\(/.test(t));
  const composeDesktop = Object.entries(f.files).find(([p, t]) => /build\.gradle\.kts$/.test(p) && /compose\.desktop|org\.jetbrains\.compose/.test(t));
  const mobileDirs = has(/^(android\/app\/build\.gradle(\.kts)?|ios\/[^/]+\.xcodeproj\/)/) || (Boolean(f.files["pubspec.yaml"]) && has(/^(android|ios)\//));
  const kmp = Object.entries(f.files).find(([p, t]) => /build\.gradle\.kts$/.test(p) && /multiplatform/.test(t) && /androidMain|android\(/.test(t));
  if (mobileDirs || dep(["react-native", "expo"]) || kmp)
    return { kind: "mobile", label: composeDesktop || desk ? "a mobile and desktop app" : "a mobile app", why: dep(["react-native", "expo"]) ? `${dep(["react-native", "expo"])} in package.json` : kmp ? "a Kotlin Multiplatform project" : "android or ios project folders" };
  if (desk || has(/(^|\/)src-tauri\//) || qt || composeDesktop)
    return { kind: "desktop", label: "a desktop app", why: desk ? `${desk} in ${deps.get(desk.toLowerCase())!.file}` : qt ? `Qt in ${qt[0]}` : composeDesktop ? "Compose Desktop" : "a src-tauri folder" };

  // Its own published package: a library, even with a command (Next.js, FastAPI), unless the command is the point.
  const ownPkg = Object.entries(f.files)
    .filter(([p]) => /(^|\/)package\.json$/.test(p) && p.split("/").length <= 3 && !MINOR_DIR.test(p))
    .map(([p, t]) => [p, json(t)] as const)
    .find(([, j]) => j && !j.private && typeof j.name === "string" && [norm(name), norm(name).replace(/-js$/, "")].includes(norm(j.name)));
  const pyproject = f.files["pyproject.toml"] ?? "";
  const pyLib = /\[project\]/.test(pyproject) && /Topic :: Software Development :: Libraries|Framework :: |Intended Audience :: Developers/.test(pyproject) && !containers;
  if (ownPkg && (ownPkg[1].main || ownPkg[1].exports || ownPkg[1].module || ownPkg[1].types)) return { kind: "library", label: "a library", why: `the ${ownPkg[1].name} package (${ownPkg[0]})` };
  if (pyLib) return { kind: "library", label: "a library", why: "a Python package for developers (pyproject.toml)" };

  // Rust and Go programs: the crate or command named like the repo decides, not a server crate elsewhere (Zellij).
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cargoMain = f.paths.find((p) => new RegExp(`^src\\/main\\.rs$|^(crates\\/)?${esc}(-cli)?\\/src\\/main\\.rs$`, "i").test(p)) ?? (/^\[\[bin\]\]/m.test(f.files["Cargo.toml"] ?? "") ? "Cargo.toml" : null);
  const goMain = f.paths.find((p) => /^(cmd\/[^/]+\/)?main\.go$/.test(p));
  const web = dep(WEB);
  const lib = pkg && !pkg.private && (pkg.main || pkg.exports || pkg.module || pkg.types) && !pkg.scripts?.start;
  if (cargoMain && !(server && containers)) return { kind: "cli", label: "a command-line tool", why: cargoMain };
  if (pkg?.bin || /\[project\.scripts\]|\[tool\.poetry\.scripts\]|console_scripts/.test(pyproject + (f.files["setup.py"] ?? "")) || (goMain && !web))
    if (!web || pkg?.bin) return { kind: "cli", label: "a command-line tool", why: pkg?.bin ? "a bin entry in package.json" : goMain ? "a Go main package with no web framework" : dep(CLI_DEPS) ?? "a script entry in pyproject.toml" };
  if (web && !lib) return { kind: "app", label: "a web app or service", why: `${web} in ${deps.get(web.toLowerCase())!.file}` };
  if (lib || (has(/^src\/lib\.rs$/) && !has(/^src\/main\.rs$/)) || (f.files["go.mod"] && !Object.entries(f.files).some(([p, t]) => /\.go$/.test(p) && !MINOR_DIR.test(p) && /^package main\b/m.test(t))))
    return { kind: "library", label: "a library", why: lib ? "main/exports in package.json, no start script" : has(/^src\/lib\.rs$/) ? "src/lib.rs" : "a Go module without a main package" };
  // A private monorepo root whose packages are published: a library collection (Vue).
  const published = Object.entries(f.files).filter(([p, t]) => /^packages\/[^/]+\/package\.json$/.test(p) && (() => { const j = json(t); return j && !j.private && (j.main || j.exports || j.module); })()).length;
  if (pkg?.private && published >= 2 && !containers) return { kind: "library", label: "a library", why: `${published} published packages under packages/` };
  if (containers) return { kind: "app", label: "an app that runs as a service", why: "a Dockerfile or Compose file" };
  if (/\[project\]/.test(pyproject) || f.files["setup.py"]) return { kind: "library", label: "a library", why: "a Python package without a command" };
  if (/\bgame engine\b|\bengine\b/i.test(text) && has(/(^|\/)(SConstruct|CMakeLists\.txt)$/)) return { kind: "desktop", label: "a desktop app", why: "a native build (engine)" };
  return { kind: "other", label: "a project", why: "no clear signals" };
}

const APPLIES: Record<string, ProjectKind[]> = {
  setup: ["app", "cli", "library", "desktop", "mobile", "extension", "plugin", "template", "other"],
  config: ["app", "cli", "desktop", "template", "other"],
  services: ["app", "cli", "desktop", "template", "other"],
  lockfile: ["app", "cli", "desktop", "mobile", "template", "other"],
  tests: ["app", "cli", "library", "desktop", "mobile", "extension", "template", "other"],
  deploy: ["app"],
};
const NAME: Record<string, string> = { config: "settings the code reads", services: "databases and other services", lockfile: "lock files", tests: "tests and CI", deploy: "deployment, health checks and backups", setup: "setup steps" };

// ── Commands in the docs ──────────────────────────────────────────────────────────────────────────────────────────
// foreign: inside another repo the steps cloned (Playwright MCP's contributor steps clone Playwright). contrib: from
// contributor or build-from-source docs, not the way users install it.
export type Command = { argv: string[]; raw: string; doc: string; line: number; cwd: string | null; inline: boolean; foreign?: boolean; contrib?: boolean; section?: string };
// Docs written for contributors, or the part of a README about developing it.
const CONTRIB_DOC = /(^|\/)(CONTRIBUTING|DEVELOP(MENT|ING)?|HACKING|BUILD(ING)?)(\.[\w-]+)?\.\w+$|(^|\/)docs?\/(.+\/)?[^/]*(contribut|develop|hacking|building)[^/]*$/i;
const CONTRIB_HEADING = /^#{1,4}\s+.*\b(contribut\w*|develop(ment|ing|er)?s?|hacking|build(ing)? (it )?from source|from source|local development|running (the )?tests|testing|benchmarks?)\b/i;
const SHELL_LANG = /^(|sh|bash|shell|console|zsh|fish|terminal|sh-session|shellsession|bash-session|powershell|ps1|pwsh|bat|cmd|cli|text|txt|plain)$/i;
const WORD = /"[^"]*"|'[^']*'|\S+/g;
const argv = (s: string) => (s.match(WORD) ?? []).map((w) => w.replace(/^["']|["']$/g, ""));

export function commands(f: Files, repoName: string, docs = docsOf(f)): Command[] {
  const out: Command[] = [];
  for (const doc of docs) {
    if (!/\.(md|mdx|markdown)$/i.test(doc)) continue;
    // Hidden HTML comments aren't instructions (yt-dlp keeps old text in one); blanked line for line.
    const text = f.files[doc].replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ""));
    const rows = text.split("\n");
    const docContrib = CONTRIB_DOC.test(doc);
    let sectionContrib = false;
    let section = ""; // the "##" section a command sits in, for following one route through the docs
    let fence: { mark: string; lang: string; start: number; body: string[]; contrib: boolean } | null = null;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!fence && /^#{1,4}\s/.test(row)) sectionContrib = CONTRIB_HEADING.test(row);
      if (!fence && /^#{1,3}\s/.test(row)) section = row.replace(/^#+\s*/, "").trim();
      const open = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(row);
      if (fence) {
        if (open && open[1].startsWith(fence.mark[0]) && open[1].length >= fence.mark.length && !open[2]) {
          if (SHELL_LANG.test(fence.lang)) out.push(...block(fence.body, doc, fence.start + 1, repoName).map((c) => ({ ...c, contrib: c.contrib || fence!.contrib, section: `${doc}#${section}` })));
          fence = null;
        } else fence.body.push(row);
        continue;
      }
      if (open) {
        fence = { mark: open[1], lang: open[2], start: i + 1, body: [], contrib: docContrib || sectionContrib };
        continue;
      }
      // Inline commands: `npm run dev` in a sentence. Only package scripts and make targets are checked for these.
      for (const m of row.matchAll(/`((?:npm|pnpm|yarn|bun|make)\s[^`]{1,80})`/g)) out.push({ argv: argv(m[1]), raw: m[1], doc, line: i + 1, cwd: null, inline: true, contrib: docContrib || sectionContrib });
    }
  }
  return out;
}

function block(body: string[], doc: string, first: number, repoName: string): Command[] {
  const out: Command[] = [];
  const prompted = body.some((r) => /^\s*\$\s/.test(r));
  let cwd: string | null = "";
  let cloned = false;
  let foreign = false; // cloned another repo and went into it
  for (let i = 0; i < body.length; i++) {
    let row = body[i];
    const at = first + i;
    if (prompted) {
      if (!/^\s*\$\s/.test(row)) continue; // output lines in a console block
      row = row.replace(/^\s*\$\s/, "");
    }
    while (/\\\s*$/.test(row) && i + 1 < body.length) row = row.replace(/\\\s*$/, " ") + body[++i];
    row = row.replace(/^\s*(>|%|PS [^>]*>)\s+/, "").replace(/\s+#\s.*$/, "").trim();
    if (!row || row.startsWith("#") || row.startsWith("//")) continue;
    for (let part of row.split(/\s*(?:&&|\|\||;)\s*/)) {
      part = part.split(/\s\|\s/)[0].trim();
      let a = argv(part);
      while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a = a.slice(1);
      while (a.length && /^(sudo|time|exec|command|env)$/.test(a[0])) a = a.slice(1);
      if (!a.length) continue;
      if (a[0] === "git" && a[1] === "clone") {
        const url = a.slice(2).find((x) => !x.startsWith("-")) ?? "";
        const target = a.slice(2).filter((x) => !x.startsWith("-"))[1];
        cloned = (target ?? url.replace(/\.git$/, "").split(/[/:]/).pop() ?? "").toLowerCase() === repoName.toLowerCase() || !url.includes("/");
        cwd = null; // cloned somewhere: the next "cd" into it brings us back to the repo root
        if (!cloned) foreign = true;
        else out.push({ argv: a, raw: part, doc, line: at, cwd: "", inline: false }); // the "get the code" step
        continue;
      }
      if (a[0] === "cd") {
        const to = a[1] ?? "";
        const base = to.replace(/\/+$/, "").split("/").pop() ?? "";
        if (!to || to === "~" || to === "-" || /^[/$~]/.test(to) || /[$`%]/.test(to)) cwd = null;
        else if (base.toLowerCase() === repoName.toLowerCase() || (cloned && cwd === null && !to.includes("/"))) {
          cwd = "";
          foreign = false;
        }
        else cwd = cwd === null ? null : join(cwd, to);
        continue;
      }
      out.push({ argv: a, raw: part, doc, line: at, cwd, inline: false, foreign: foreign && cwd === null });
    }
  }
  return out;
}

// ── .gitignore (root only, the common patterns) ───────────────────────────────────────────────────────────────────
function ignored(f: Files): (p: string) => boolean {
  const res = (f.files[".gitignore"] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((l) => {
      const anchored = l.replace(/\/$/, "").includes("/");
      const body = l.replace(/^\//, "").replace(/\/$/, "").replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
      return new RegExp(anchored ? `^${body}(/|$)` : `(^|/)${body}(/|$)`);
    });
  return (p) => res.some((re) => re.test(p));
}

const NPM_BUILTIN = new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "update", "up", "audit", "init", "create", "exec", "x", "link", "unlink", "publish", "pack", "config", "cache", "outdated", "ls", "list", "login", "logout", "version", "view", "info", "help", "dedupe", "prune", "rebuild", "explain", "why", "doctor", "fund", "global", "dlx", "import", "store", "env", "setup", "workspace", "workspaces", "set", "patch", "patch-commit", "plugin", "constraints", "dedupe", "deploy", "fetch", "licenses", "root", "bin", "node", "upgrade", "upgrade-interactive", "unplug", "search", "stage", "tag", "team", "owner", "whoami", "pm", "repl", "build", "-v", "--version", "-h", "--help", "self-update"]);

type Missing = { what: string; detail: string; doc: string; line: number; contrib: boolean };

const BINS = new Set(["playwright", "prisma", "tsc", "eslint", "jest", "vitest", "next", "vite", "turbo", "nx", "lerna", "husky", "prettier", "tsx", "ts-node", "drizzle-kit", "knex", "sequelize", "typeorm", "storybook", "webpack", "rollup", "esbuild", "tailwindcss", "electron", "expo", "react-native", "nest", "ng", "nuxt", "astro", "svelte-kit", "remix", "wrangler", "vercel", "netlify", "supabase", "changeset", "biome", "oxlint", "dotenv", "cross-env", "rimraf", "concurrently", "nodemon", "pm2", "serve", "http-server", "create-react-app", "degit", "patch-package", "lint-staged", "commitlint", "cypress", "mocha", "ava", "c8", "nyc", "typedoc", "tsup", "unbuild", "pkg", "ncc", "node-gyp", "prebuild", "electron-builder", "electron-forge"]);

function checkCommands(f: Files, cmds: Command[], deps: Map<string, Dep>, repoName = "") {
  // Right after `git clone`, paths start with the clone's folder name ("cp -R leanrea/leanrea ~/…").
  const inClone = new RegExp(`^(\\./)?${repoName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`, "i");
  const pathSet = new Set(f.paths);
  const dirs = new Set<string>();
  for (const p of f.paths) for (let d = dirOf(p); d; d = dirOf(d)) dirs.add(d);
  const exists = (p: string) => pathSet.has(p) || dirs.has(p);
  const anywhere = (rel: string) => {
    const r = rel.replace(/^\.\//, "").replace(/\/+$/, "");
    return exists(r) || f.paths.some((p) => p.endsWith(`/${r}`) || p.includes(`/${r}/`));
  };
  const isIgnored = ignored(f);
  const scripts = new Map<string, Set<string>>();
  for (const [p, t] of Object.entries(f.files)) if (p.split("/").pop() === "package.json") scripts.set(dirOf(p), new Set(Object.keys(json(t)?.scripts ?? {})));
  const allScripts = new Set([...scripts.values()].flatMap((s) => [...s]));
  const makefiles = Object.entries(f.files).filter(([p]) => MAKEFILE.test(p));
  const generatedMake = f.paths.some((p) => /(^|\/)(configure(\.ac)?|CMakeLists\.txt|meson\.build|Makefile\.(am|in)|premake\d?\.lua|\.mk)$/.test(p)) || makefiles.some(([, t]) => /^\s*-?include\s/m.test(t));
  const targets = new Set<string>();
  let patternMake = false;
  for (const [, t] of makefiles)
    for (const m of t.matchAll(/^([^\s:#=][^:#=]*?)\s*::?(?!=)/gm)) {
      if (/[%$]/.test(m[1])) patternMake = true;
      for (const name of m[1].split(/\s+/)) targets.add(name);
    }
  const created = new Set<string>();
  const made = (p: string | null | undefined) => p && created.add(p.replace(/^\.\//, "").replace(/\/+$/, ""));
  const wasMade = (p: string) => [...created].some((c) => p === c || p.startsWith(`${c}/`) || p.endsWith(`/${c}`) || c.endsWith(`/${p}`));
  const missing: Missing[] = [];
  let checked = 0;
  const miss = (c: Command, what: string, detail: string) => {
    const had = missing.find((m) => m.what === what && m.detail === detail);
    if (!had) missing.push({ what, detail, doc: c.doc, line: c.line, contrib: Boolean(c.contrib) });
    else if (had.contrib && !c.contrib) Object.assign(had, { doc: c.doc, line: c.line, contrib: false }); // the user-facing mention wins
  };
  // Docs that hand you the file to write ("Create a docker-compose.yml:" and the YAML) aren't missing anything.
  const createsIn = (doc: string, what: RegExp) => {
    const t = f.files[doc] ?? "";
    return new RegExp(`\\b(create|write|make|add|save|copy|paste)\\b[^.\\n]{0,80}${what.source}`, "i").test(t) || (what.source.includes("compose") && /```ya?ml\s*\n\s*(version:[^\n]*\n\s*)?services:/i.test(t));
  };
  const badPath = (p: string) => !p || /[$<>{}*?~:%`|]|^\//.test(p) || /^https?:/i.test(p) || p.startsWith("-") || p.length > 120;
  const checkFile = (c: Command, rel: string, what = "file") => {
    if (badPath(rel)) return;
    if (c.cwd === null && repoName && inClone.test(rel)) rel = rel.replace(inClone, "");
    checked++;
    const full = c.cwd === null ? null : join(c.cwd, rel);
    if ((full !== null && exists(full)) || anywhere(rel) || wasMade(rel) || (full && wasMade(full)) || isIgnored(rel.replace(/^\.\//, "")) || (full && isIgnored(full))) return;
    miss(c, what, rel.replace(/^\.\//, ""));
  };

  for (const c of cmds) {
    const a = c.argv;
    const [cmd, sub] = a;
    // Another repo's steps, or a pattern rather than a command ("pnpm run [script]", "npm run <name>").
    if (c.foreign || a.some((x) => /^[<[{].*[>\]}]$|^<|>$/.test(x))) continue;
    const flags = a.filter((x) => x.startsWith("-"));
    // What earlier steps create, so later steps that use it aren't flagged.
    if (cmd === "mkdir" || cmd === "touch") a.slice(1).filter((x) => !x.startsWith("-")).forEach(made);
    if ((cmd === "cp" || cmd === "mv" || cmd === "ln" || cmd === "copy") && a.length >= 3) made(a.at(-1));
    for (let i = 0; i < a.length - 1; i++) if (/^(>|>>|-o|-O|--output|--out|-d|--dir)$/.test(a[i])) made(a[i + 1]);
    const redirect = /\s>>?\s*(\S+)/.exec(c.raw);
    if (redirect) made(redirect[1]);
    if (/^(python3?|py)$/.test(cmd ?? "") && sub === "-m" && /^(venv|virtualenv)$/.test(a[2] ?? "")) made(a.find((x, i) => i > 2 && !x.startsWith("-")));
    if (cmd === "virtualenv" || (cmd === "uv" && sub === "venv")) made(a.find((x, i) => i > (cmd === "uv" ? 1 : 0) && !x.startsWith("-")) ?? ".venv");
    if ((cmd === "wget" || cmd === "curl") && a.some((x) => /^https?:/.test(x))) made(a.find((x) => /^https?:/.test(x))!.split("/").pop());

    // Package scripts.
    let script: string | null = null;
    const viaWorkspace = flags.some((x) => /^(--filter|-F|-C|--dir|-r|--recursive|--workspace|-w|--prefix|--cwd|--ws|--workspaces)(=|$)/.test(x)) || a.includes("workspace") || a.includes("workspaces");
    if (cmd === "npm" && (sub === "run" || sub === "run-script")) script = a[2] && !a[2].startsWith("-") ? a[2] : null;
    else if (cmd === "npm" && /^(start|test|t|tst|stop|restart)$/.test(sub ?? "")) script = /^t(e?st)?$/.test(sub!) || sub === "tst" ? "test" : sub!;
    else if ((cmd === "pnpm" || cmd === "yarn" || cmd === "bun") && sub === "run") script = a[2] && !a[2].startsWith("-") ? a[2] : null;
    else if ((cmd === "pnpm" || cmd === "yarn") && sub && !sub.startsWith("-") && !NPM_BUILTIN.has(sub)) script = sub;
    if (script && /\.\w{1,4}$/.test(script) && cmd === "bun") script = null; // `bun run file.ts`
    // yarn, pnpm and bun also run tools installed as dependencies (`yarn playwright`); only npm run is scripts-only.
    if (script && cmd !== "npm" && (BINS.has(script) || [...deps.keys()].some((d) => d === script || d.endsWith(`/${script}`) || d === `@${script}/cli`))) script = null;
    if (script && !viaWorkspace) {
      checked++;
      const here = c.cwd !== null ? scripts.get(c.cwd) : undefined;
      const ok = here?.has(script) || allScripts.has(script) || (script === "start" && (f.paths.includes(join(c.cwd ?? "", "server.js") ?? "") || f.paths.some((p) => p.endsWith("server.js"))));
      if (!scripts.size) miss(c, "manifest", "package.json");
      else if (!ok) miss(c, "script", script);
    }
    // Make targets.
    if (cmd === "make" && !generatedMake && !flags.some((x) => /^-(f|C)/.test(x) || x === "--file" || x === "--directory")) {
      const target = a.slice(1).find((x) => !x.startsWith("-") && !x.includes("="));
      checked++;
      if (!makefiles.length && !c.inline) miss(c, "manifest", "Makefile");
      else if (target && makefiles.length && !patternMake && !targets.has(target)) miss(c, "target", target);
    }
    if (c.inline) continue;

    // Files the steps use.
    if ((cmd === "cp" || cmd === "copy") && a.length >= 3) checkFile(c, a.filter((x, i) => i > 0 && !x.startsWith("-"))[0]);
    if (/^(bash|sh|zsh|source|\.)$/.test(cmd ?? "") && sub && !sub.startsWith("-") && /[./]/.test(sub)) checkFile(c, sub);
    if (cmd?.startsWith("./") && cmd.length > 2) checkFile(c, cmd);
    if (/^(python3?|py|node|tsx|ts-node|deno|ruby|php|perl)$/.test(cmd ?? "")) {
      const file = a.slice(1).find((x) => !x.startsWith("-") && x !== "run");
      const idx = file ? a.indexOf(file) : -1;
      const prev = a[idx - 1];
      if (file && /\.(py|[cm]?js|ts|rb|php|pl)$/.test(file) && prev !== "-m" && prev !== "-c" && prev !== "-e") checkFile(c, file);
    }
    if (/^(pip3?|uv)$/.test(cmd ?? "") || (cmd === "python" && a.includes("pip"))) for (let i = 0; i < a.length - 1; i++) if (a[i] === "-r" || a[i] === "--requirement" || a[i] === "-c") checkFile(c, a[i + 1]);
    if ((cmd === "docker" && sub === "compose") || cmd === "docker-compose") {
      const fi = a.findIndex((x) => x === "-f" || x === "--file");
      if (fi > 0) checkFile(c, a[fi + 1]);
      else if (a.some((x) => /^(up|run|start|build|pull|exec)$/.test(x))) {
        checked++;
        if (!f.paths.some((p) => COMPOSE.test(p)) && !createsIn(c.doc, /(docker-)?compose/)) miss(c, "manifest", "a Docker Compose file");
      }
    }
    if (cmd === "docker" && sub === "build") {
      const fi = a.findIndex((x) => x === "-f" || x === "--file");
      if (fi > 0) checkFile(c, a[fi + 1]);
      else {
        checked++;
        if (!f.paths.some((p) => DOCKERFILE.test(p)) && !createsIn(c.doc, /Dockerfile/)) miss(c, "manifest", "a Dockerfile");
      }
    }
    if (cmd === "npm" && sub === "ci") {
      checked++;
      if (!f.paths.some((p) => /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/.test(p))) miss(c, "lock", "package-lock.json");
    }
    const needs: [boolean, RegExp, string][] = [
      [cmd === "poetry" && /^(install|run|shell)$/.test(sub ?? ""), /(^|\/)pyproject\.toml$/, "pyproject.toml"],
      [cmd === "cargo" && /^(build|run|install|test)$/.test(sub ?? "") && !a.includes("--git") && !(sub === "install" && a.some((x, i) => i > 1 && !x.startsWith("-") && x !== "--path" && x !== ".")), /(^|\/)Cargo\.toml$/, "Cargo.toml"],
      [cmd === "bundle" && /^(install|exec)$/.test(sub ?? ""), /(^|\/)Gemfile$/, "Gemfile"],
      [cmd === "composer" && sub === "install", /(^|\/)composer\.json$/, "composer.json"],
      [cmd === "go" && /^(build|run|install|test)$/.test(sub ?? "") && a.some((x) => /^\.\/|^\.$/.test(x)), /(^|\/)go\.mod$/, "go.mod"],
    ];
    for (const [when, re, name] of needs)
      if (when) {
        checked++;
        if (!f.paths.some((p) => re.test(p))) miss(c, "manifest", name);
      }
  }
  return { missing, checked };
}

// ── Versions: what the docs say against what the files require ────────────────────────────────────────────────────
type Version = { major: number; minor: number | null; source: string; line: number; text: string };
function lowest(range: string): [number, number | null] | null {
  let best: [number, number | null] | null = null;
  for (const alt of range.split("||")) {
    const parts = alt.split(/,|\s+(?=[<>=^~])/).map((x) => x.trim()).filter(Boolean);
    let found: [number, number | null] | null = null;
    let onlyUpper = parts.length > 0;
    for (const p of parts) {
      const m = /^(>=|>|\^|~=|~|==|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?/.exec(p);
      if (!m || /^</.test(p)) continue;
      onlyUpper = false;
      found = [Number(m[2]), m[3] && /\d/.test(m[3]) ? Number(m[3]) : null];
      break;
    }
    if (onlyUpper || !found) return null;
    if (!best || found[0] < best[0] || (found[0] === best[0] && (found[1] ?? 0) < (best[1] ?? 0))) best = found;
  }
  return best;
}
const below = (doc: Version, req: [number, number | null]) => doc.major < req[0] || (doc.major === req[0] && doc.minor !== null && req[1] !== null && doc.minor < req[1]);
const NOT_SUPPORTED = /no longer|not supported|unsupported|deprecated|dropped|drops|end[- ]of[- ]life|\bEOL\b|removed support|older than|below|prior to|before/i;

function documentedVersions(f: Files, docs: string[], re: RegExp, valid: (major: number) => boolean): Version[] {
  const out: Version[] = [];
  for (const doc of docs) {
    const text = f.files[doc].replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " ")); // hidden comments aren't docs
    for (const m of text.matchAll(re)) {
      const major = Number(m[1]);
      const minor = m[2] !== undefined ? Number(m[2]) : null;
      if (!valid(major)) continue;
      // Only the words around the mention: a paragraph can be one long line.
      const before = text.slice(Math.max(0, m.index! - 80), m.index!);
      const near = before + text.slice(m.index!, m.index! + m[0].length + 80);
      if (NOT_SUPPORTED.test(near) || /\b(as of|since|starting (with|from|in)|introduced in|added in|until|from|after)\s*$/i.test(before) || /@types\/node|setup-node@|node_modules/i.test(near)) continue;
      out.push({ major, minor, source: doc, line: lines(text, m.index!), text: m[0].trim() });
    }
  }
  return out;
}

type Required = { range: string; low: [number, number | null]; source: string; line: number; pin?: boolean };
function requiredVersions(f: Files) {
  const at = (path: string, re: RegExp): Required | null => {
    const t = f.files[path];
    const m = t ? re.exec(t) : null;
    const low = m ? lowest(m[1]) : null;
    return m && low ? { range: m[1].trim(), low, source: path, line: lines(t!, m.index), pin: /^v?\d+(\.\d+)*$/.test(m[1].trim()) } : null;
  };
  const dockerFrom = (img: string) => {
    const df = Object.keys(f.files).find((p) => DOCKERFILE.test(p) && !p.includes("/"));
    return df ? at(df, new RegExp(`^FROM\\s+(?:--platform=\\S+\\s+)?(?:docker\\.io\\/)?(?:library\\/)?${img}:v?(\\d+(?:\\.\\d+)?)`, "mi")) : null;
  };
  const node = [
    at("package.json", /"node"\s*:\s*"([^"]+)"/),
    at(".nvmrc", /^\s*v?(\d+(?:\.\d+)*)\s*$/m),
    at(".node-version", /^\s*v?(\d+(?:\.\d+)*)\s*$/m),
    at(".tool-versions", /^nodejs\s+(\d+(?:\.\d+)*)/m),
    dockerFrom("node"),
  ].filter((x): x is Required => Boolean(x));
  // engines sits under "engines" in package.json; anything else called "node" there (rare) would be a mistake.
  if (node[0]?.source === "package.json" && !/"engines"\s*:\s*\{[^}]*"node"/.test(f.files["package.json"] ?? "")) node.shift();
  const python = [
    at("pyproject.toml", /requires-python\s*=\s*["']([^"']+)["']/),
    at("pyproject.toml", /^\s*python\s*=\s*["']([^"']+)["']/m),
    at("setup.py", /python_requires\s*=\s*["']([^"']+)["']/),
    at("setup.cfg", /python_requires\s*=\s*(\S+)/),
    at(".python-version", /^\s*(3\.\d+)/m),
    at("runtime.txt", /python-(3\.\d+)/),
    dockerFrom("python"),
  ].filter((x): x is Required => Boolean(x));
  const go = [at("go.mod", /^go\s+(1\.\d+)/m), dockerFrom("golang")].filter((x): x is Required => Boolean(x));
  const rust = [at("Cargo.toml", /rust-version\s*=\s*["']([^"']+)["']/), at("rust-toolchain.toml", /channel\s*=\s*["'](\d+\.\d+)/), at("rust-toolchain", /^(\d+\.\d+)/m)].filter((x): x is Required => Boolean(x));
  const ruby = [at(".ruby-version", /^\s*(?:ruby-)?(\d+\.\d+)/m), at("Gemfile", /^ruby\s+["']([^"']+)["']/m)].filter((x): x is Required => Boolean(x));
  const php = [at("composer.json", /"php"\s*:\s*"([^"]+)"/)].filter((x): x is Required => Boolean(x));
  return { node, python, go, rust, ruby, php };
}

// ── Settings the code reads ───────────────────────────────────────────────────────────────────────────────────────
type EnvUse = { name: string; path: string; line: number; fallback: boolean };
const IGNORE_ENV = /^(NODE_ENV|PORT|HOST|HOSTNAME|HOME|PATH|PWD|USER|USERNAME|SHELL|TERM|LANG|LC_\w+|TZ|CI|DEBUG|NODE_OPTIONS|NEXT_RUNTIME|NEXT_PHASE|NODE_DEBUG|VERCEL\w*|NETLIFY\w*|RENDER\w*|RAILWAY_\w+|HEROKU\w*|FLY_\w+|GITHUB_(ACTIONS|WORKSPACE|SHA|REF\w*|RUN_\w+|EVENT_\w+|REPOSITORY\w*|SERVER_URL|API_URL|OUTPUT|ENV|STEP_SUMMARY|ACTOR\w*|JOB|HEAD_REF|BASE_REF|PATH)|RUNNER_\w+|npm_\w+|PYTHON\w*|VIRTUAL_ENV|CONDA_\w+|XDG_\w+|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES\w*|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|TMPDIR|TEMP|TMP|EDITOR|VISUAL|BROWSER|DISPLAY|WAYLAND_DISPLAY|NO_COLOR|FORCE_COLOR|COLORTERM|TERM_PROGRAM\w*|COLUMNS|LINES|MODE|DEV|PROD|SSR|BASE_URL|KUBERNETES_\w+|AWS_LAMBDA_\w+|AWS_EXECUTION_ENV|LAMBDA_\w+|JEST_WORKER_ID|VITEST\w*|PLAYWRIGHT\w*|CF_PAGES\w*|GOPATH|GOROOT|GOOS|GOARCH|CARGO\w*|RUST_\w+|JAVA_HOME|ANDROID_\w+|LOG_LEVEL|LOGLEVEL|VERBOSE|SILENT|QUIET|NODE_TLS_REJECT_UNAUTHORIZED|HTTPS?_PROXY|NO_PROXY|ALL_PROXY|__\w+|SSH_\w+|GPG_\w+|DOCKER_\w+|WSL\w*|OS|SHLVL|LOGNAME|MAIL|OLDPWD|INIT_CWD|EXPO_\w+|ELECTRON_\w+|CODESPACES?\w*|GITPOD_\w+)$/;
// Variables that belong to the operating system, a desktop toolkit or a machine-learning stack, not the app's own settings.
const OS_ENV = /^(HOMEDRIVE|HOMEPATH|SYSTEMDRIVE|PROCESSOR_\w+|NUMBER_OF_PROCESSORS|QT_\w+|GDK_\w+|GTK_\w+|XCURSOR\w*|DESKTOP_SESSION|KDE_\w+|GNOME_\w+|SNAP\w*|FLATPAK\w*|APPIMAGE|APPDIR|LD_\w+|DYLD_\w+|PULSE_\w+|SDL_\w+|VK_\w+|MESA_\w+|LIBVA_\w+|__GL\w*|CUDA_\w+|NVIDIA_\w+|PYTORCH_\w+|TORCH_\w+|HF_\w+|HUGGINGFACE_\w+|TRANSFORMERS_\w+|TOKENIZERS_\w+|OMP_\w+|MKL_\w+|OPENBLAS_\w+|KMP_\w+|DO_NOT_TRACK|PYTEST_\w+|COVERAGE_\w+|TF_\w+|JAX_\w+|XLA_\w+)$/;
// The repo's own maintenance scripts (regenerating the README, releasing), not code that runs when you use it.
const REPO_SCRIPT = /(^|\/)(update|generate|gen|build|release|bump|publish|prepare|postinstall|sync|check)[-_.][\w.-]*\.(m?[jt]s|py|sh|rb)$/i;
const ENV_READS: [RegExp, (m: RegExpExecArray, after: string) => boolean][] = [
  [/process\.env\.([A-Z][A-Z0-9_]{2,})\b/g, (_, a) => /^\s*(\|\||\?\?|\?(?!\.)|!==?\s*undefined\s*\?)/.test(a)],
  [/process\.env\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g, (_, a) => /^\s*(\|\||\?\?|\?(?!\.))/.test(a)],
  [/import\.meta\.env\.([A-Z][A-Z0-9_]{2,})\b/g, (_, a) => /^\s*(\|\||\?\?|\?(?!\.))/.test(a)],
  [/\bDeno\.env\.get\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g, (_, a) => /^\s*(\|\||\?\?)/.test(a)],
  [/\bBun\.env\.([A-Z][A-Z0-9_]{2,})\b/g, (_, a) => /^\s*(\|\||\?\?)/.test(a)],
  [/os\.environ\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g, () => false],
  [/os\.environ\.get\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g, () => true],
  [/os\.getenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g, () => true],
  [/os\.(?:Getenv|LookupEnv)\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g, () => true],
  [/env::var(?:_os)?\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g, (_, a) => /^\s*\.(unwrap_or|ok\(\)|is_ok|unwrap_or_else|unwrap_or_default)/.test(a)],
  [/\bENV\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g, (_, a) => /^\s*(\|\||\|\|=|\.presence)/.test(a)],
  [/\bENV\.fetch\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*(,|\)\s*\{)?/g, (m) => Boolean(m[2])],
  [/\bgetenv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\)/g, (_, a) => /^\s*(\?:|\?\?|\|\|)/.test(a)],
  [/\$_ENV\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g, (_, a) => /^\s*\?\?/.test(a)],
  [/\benv\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*(,)?/g, (m) => Boolean(m[2])],
  [/System\.getenv\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g, (_, a) => /^\s*(\?:|\?\.let|\?:)/.test(a)],
  [/Environment\.GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]{2,})"\s*\)/g, (_, a) => /^\s*\?\?/.test(a)],
];
export function envReads(f: Files): EnvUse[] {
  const out = new Map<string, EnvUse>();
  let scanned = 0;
  for (const [p, t] of Object.entries(f.files)) {
    if (!CODE.test(p) || NOT_APP_CODE.test(p) || REPO_SCRIPT.test(p) || scanned++ > 4000) continue;
    if (!/env/.test(t)) continue;
    for (const [re, hasFallback] of ENV_READS) {
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const name = m[1];
        if (IGNORE_ENV.test(name) || OS_ENV.test(name)) continue;
        const after = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
        const before = t.slice(Math.max(0, m.index - 24), m.index);
        if (/^\s*=(?!=)/.test(after)) continue; // the code sets it (os.environ["X"] = "1"), it doesn't need it
        // Only checked, never required: `if (process.env.X)`, `X is None`, `"X" in os.environ`.
        const guarded = /\b(if|elif|unless|when|while)\s*\(?\s*!?\s*$|(&&|\|\||\?)\s*!?\s*$/.test(before) || /^\s*(\)\s*(\{|:|&&|\|\|)|is (not )?None|[!=]==?|&&|\|\||\?(?!\.))/.test(after);
        const fallback = guarded || hasFallback(m, after);
        const seen = out.get(name);
        if (!seen) out.set(name, { name, path: p, line: lines(t, m.index), fallback });
        else if (seen.fallback && !fallback) out.set(name, { ...seen, fallback: false }); // read without a default somewhere
      }
    }
    // const { A, B = "x" } = process.env
    for (const m of t.matchAll(/\{([^{}]{1,600})\}\s*=\s*process\.env\b/g))
      for (const part of m[1].split(",")) {
        const name = /^\s*([A-Z][A-Z0-9_]{2,})/.exec(part)?.[1];
        if (name && !IGNORE_ENV.test(name) && !out.has(name)) out.set(name, { name, path: p, line: lines(t, m.index!), fallback: part.includes("=") });
      }
  }
  return [...out.values()];
}

// ── Services the code needs to be running ─────────────────────────────────────────────────────────────────────────
type Service = { name: string; deps: string[]; url?: RegExp; env: RegExp; image: RegExp; docs: RegExp; prisma?: string; sql?: boolean };
const SERVICES: Service[] = [
  { name: "PostgreSQL", deps: ["pg", "postgres", "pg-promise", "psycopg2", "psycopg2-binary", "psycopg", "asyncpg", "github.com/lib/pq", "github.com/jackc/pgx/v5", "github.com/jackc/pgx/v4", "tokio-postgres"], url: /postgres(?:ql)?:\/\/(?!user:password@host)/i, env: /^(POSTGRES_(URL|HOST|PRISMA_URL)|PG_?HOST|PGDATABASE|\w+_POSTGRES_URL|DATABASE_URL)$/, image: /(^|\/)(postgres|pgvector|postgis|timescaledb|supabase\/postgres|ankane\/pgvector)\b/i, docs: /\bpostgres(ql)?\b|\bpsql\b/i, prisma: "postgresql", sql: true },
  { name: "MySQL", deps: ["mysql", "mysql2", "mysqlclient", "pymysql", "aiomysql", "github.com/go-sql-driver/mysql"], url: /mysql:\/\//i, env: /^(MYSQL_(URL|HOST)|DATABASE_URL)$/, image: /(^|\/)(mysql|mariadb)\b/i, docs: /\bmysql\b|\bmariadb\b/i, prisma: "mysql", sql: true },
  { name: "MongoDB", deps: ["mongoose", "mongodb", "pymongo", "motor", "mongoengine", "go.mongodb.org/mongo-driver", "beanie"], url: /mongodb(\+srv)?:\/\//i, env: /^(MONGO(DB)?_(URL|URI|HOST|CONNECTION_STRING)|DATABASE_URL)$/, image: /(^|\/)mongo(db)?\b/i, docs: /\bmongo(db)?\b/i, prisma: "mongodb" },
  { name: "Redis", deps: ["ioredis", "redis", "bullmq", "bull", "bee-queue", "django-redis", "rq", "github.com/redis/go-redis/v9", "github.com/go-redis/redis/v8", "predis/predis", "sidekiq", "resque", "arq", "celery[redis]"], url: /rediss?:\/\//i, env: /^(\w+_)?REDIS_(URL|HOST|URI|CONNECTION_STRING)$/, image: /(^|\/)(redis|valkey|dragonfly|keydb|redis-stack)\b/i, docs: /\bredis\b|\bvalkey\b|\bdragonfly(db)?\b/i },
  { name: "RabbitMQ", deps: ["amqplib", "amqp-connection-manager", "pika", "aio-pika", "github.com/rabbitmq/amqp091-go", "lapin", "bunny"], url: /amqps?:\/\//i, env: /^(AMQP_URL|RABBITMQ_(URL|HOST)|BROKER_URL|CELERY_BROKER_URL)$/, image: /(^|\/)rabbitmq\b/i, docs: /\brabbitmq\b|\bamqp\b/i },
  { name: "Kafka", deps: ["kafkajs", "confluent-kafka", "kafka-python", "aiokafka", "github.com/segmentio/kafka-go", "github.com/ibm/sarama", "rdkafka"], env: /^KAFKA_(BROKERS?|BOOTSTRAP_SERVERS|URL|HOST)$/, image: /\b(kafka|redpanda)\b/i, docs: /\bkafka\b|\bredpanda\b/i },
  { name: "Elasticsearch", deps: ["@elastic/elasticsearch", "elasticsearch", "elasticsearch-dsl", "@opensearch-project/opensearch", "opensearch-py"], env: /^(ELASTIC(SEARCH)?|OPENSEARCH)_(URL|HOST|NODE|ENDPOINT)$/, image: /\b(elasticsearch|opensearch)\b/i, docs: /\belastic(search)?\b|\bopensearch\b/i },
  { name: "Meilisearch", deps: ["meilisearch"], env: /^MEILI(SEARCH)?_(HOST|URL)$/, image: /\bmeilisearch\b/i, docs: /\bmeili(search)?\b/i },
  { name: "Qdrant", deps: ["@qdrant/js-client-rest", "qdrant-client", "qdrant_client"], env: /^QDRANT_(URL|HOST)$/, image: /\bqdrant\b/i, docs: /\bqdrant\b/i },
  { name: "ClickHouse", deps: ["@clickhouse/client", "clickhouse-connect", "clickhouse-driver"], env: /^CLICKHOUSE_(URL|HOST)$/, image: /\bclickhouse\b/i, docs: /\bclickhouse\b/i },
];

export function composeServices(text: string): { name: string; image: string | null; body: string; line: number }[] {
  const rows = text.split("\n");
  const start = rows.findIndex((r) => /^services:\s*$/.test(r));
  if (start < 0) return [];
  const out: { name: string; image: string | null; body: string; line: number }[] = [];
  let indent: number | null = null;
  let cur: { name: string; image: string | null; body: string[]; line: number } | null = null;
  const push = () => cur && out.push({ name: cur.name, image: cur.image, body: cur.body.join("\n"), line: cur.line });
  for (let i = start + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.trim() || /^\s*#/.test(r)) continue;
    const ind = r.length - r.trimStart().length;
    if (ind === 0) break;
    if (indent === null) indent = ind;
    if (ind === indent) {
      push();
      cur = { name: r.trim().replace(/:.*$/, "").replace(/["']/g, ""), image: null, body: [], line: i + 1 };
    } else if (cur) {
      cur.body.push(r);
      const img = /^\s*image:\s*["']?([^"'\s#]+)/.exec(r);
      if (img && ind === indent * 2) cur.image = img[1];
    }
  }
  push();
  return out;
}

// ── Secrets ───────────────────────────────────────────────────────────────────────────────────────────────────────
const SECRETS: [string, RegExp][] = [
  ["an AWS access key", /\b((?:AKIA|ASIA)[0-9A-Z]{16})\b/g],
  ["a GitHub token", /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/g],
  ["a Slack token", /\b(xox[baprs]-[0-9A-Za-z-]{10,})\b/g],
  ["a Stripe live key", /\b((?:sk|rk)_live_[0-9A-Za-z]{20,})\b/g],
  ["a Google API key", /\b(AIza[0-9A-Za-z_-]{35})\b/g],
  ["an OpenAI key", /\b(sk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{80,})\b/g],
  ["an Anthropic key", /\b(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,})\b/g],
  ["a SendGrid key", /\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/g],
  ["an npm token", /\b(npm_[A-Za-z0-9]{36})\b/g],
  ["a Twilio key", /\b(SK[0-9a-f]{32})\b/g],
  ["a Hugging Face token", /\b(hf_[A-Za-z]{34})\b/g],
  // A header alone is often just a pattern in code: a real key has its body after it.
  ["a private key", /(-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----)(?:(?:\\r)?\\n|\r?\n)(?:[A-Za-z0-9+/=]{40,}(?:(?:\\r)?\\n|\r?\n|"\s*\+?\s*"|$)){3,}/gm],
];
const PLACEHOLDER = /example|sample|dummy|fake|test|xxxx|your[_-]?|placeholder|redacted|changeme|<|\.\.\.|0{8,}|1234567|abcdef/i;
export type SecretHit = { what: string; path: string; line: number; shown: string; test: boolean; public?: boolean };
// Browser keys (Firebase, Maps) are meant to be visible and are limited by domain in the provider's console.
const PUBLIC_KEY = /(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|GATSBY_|NUXT_PUBLIC_|firebase|apiKey\s*:)/i;
export function secrets(f: Files): SecretHit[] {
  const out: SecretHit[] = [];
  const seen = new Set<string>();
  for (const [p, t] of Object.entries(f.files)) {
    if (out.length >= 50) break;
    if (DOC.test(p)) continue; // keys in docs are examples
    for (const [what, re] of SECRETS) {
      re.lastIndex = 0;
      for (let m = re.exec(t); m; m = re.exec(t)) {
        const value = m[1];
        const around = t.slice(Math.max(0, m.index - 60), m.index + value.length + 60);
        if (what !== "a private key" && (PLACEHOLDER.test(value) || /AKIAIOSFODNN7EXAMPLE|EXAMPLE/.test(around))) continue;
        if (what !== "a private key" && new Set(value.slice(4)).size < 10) continue; // repeated characters: a dummy
        if (/(^|\/)(docs?|examples?)\//i.test(p) && PLACEHOLDER.test(around)) continue;
        const line = lines(t, m.index);
        if (seen.has(`${p}:${line}`)) continue;
        seen.add(`${p}:${line}`);
        const row = t.slice(t.lastIndexOf("\n", m.index) + 1, m.index);
        // Google keys in code are client keys sites embed (YouTube's, in scrapers): public by design, unlike one in a
        // settings file. Keys in seeders, dev fixtures, redaction pattern lists or Rust test blocks are test keys.
        const before = t.slice(Math.max(0, m.index - 3000), m.index);
        const isTest =
          /(^|\/|[-_.])(tests?|__tests__|specs?|fixtures?|testdata|testing|mocks?|e2e|dummy|fake|samples?|examples?|demo|seeders?|factories|\.dev)([-_./]|$)/i.test(p) ||
          TEST_FILE.test(p) ||
          /(^|\/)[^/]*(secret|redact|scrub|sanitiz|pattern|detect)[^/]*\.\w+$/i.test(p) ||
          /#\[cfg\(test\)\]|\bdescribe\(|\bit\(['"]/.test(before) ||
          /\b(expired|revoked|fake|dummy|not a real|for testing|test key|testing host)\b/i.test(around);
        const isPublic = what === "a Google API key" && (PUBLIC_KEY.test(row) || !/(^|\/)\.env|\.(env|ini|cfg|conf|ya?ml|toml|json)$/i.test(p));
        out.push({ what, path: p, line, public: isPublic, shown: what === "a private key" ? "BEGIN … PRIVATE KEY" : `${value.slice(0, 4)}…`, test: isTest });
        if (out.length >= 50) break;
      }
    }
  }
  return out;
}

// ── Accounts you'll need ──────────────────────────────────────────────────────────────────────────────────────────
const ACCOUNTS: [RegExp, string, boolean?][] = [
  [/^OPENAI_API_KEY$/, "OpenAI", true], [/^ANTHROPIC_API_KEY$/, "Anthropic", true], [/^(GEMINI|GOOGLE_GENERATIVE_AI|GOOGLE_AI)_API_KEY$/, "Google Gemini", true],
  [/^GROQ_API_KEY$/, "Groq", true], [/^MISTRAL_API_KEY$/, "Mistral", true], [/^CO(HERE)?_API_KEY$/, "Cohere", true], [/^REPLICATE_API_(TOKEN|KEY)$/, "Replicate", true],
  [/^(HF_TOKEN|HUGGINGFACE(HUB)?_(API_)?(TOKEN|KEY)|HUGGING_FACE_HUB_TOKEN)$/, "Hugging Face", true], [/^OPENROUTER_API_KEY$/, "OpenRouter", true],
  [/^TOGETHER_API_KEY$/, "Together AI", true], [/^DEEPSEEK_API_KEY$/, "DeepSeek", true], [/^XAI_API_KEY$/, "xAI", true], [/^PERPLEXITY_API_KEY$/, "Perplexity", true], [/^ELEVENLABS_API_KEY$/, "ElevenLabs", true],
  [/^STRIPE_(SECRET_KEY|API_KEY|SK)$/, "Stripe"], [/^(NEXT_PUBLIC_)?SUPABASE_(URL|ANON_KEY|SERVICE_ROLE_KEY|KEY)$/, "Supabase"], [/^(NEXT_PUBLIC_)?FIREBASE_(API_KEY|PROJECT_ID)$/, "Firebase"],
  [/^AWS_ACCESS_KEY_ID$/, "AWS"], [/^TWILIO_(ACCOUNT_SID|AUTH_TOKEN)$/, "Twilio"], [/^SENDGRID_API_KEY$/, "SendGrid"], [/^RESEND_API_KEY$/, "Resend"], [/^POSTMARK_\w*TOKEN$/, "Postmark"], [/^MAILGUN_API_KEY$/, "Mailgun"],
  [/^PINECONE_API_KEY$/, "Pinecone"], [/^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)$/, "Cloudflare"], [/^(GITHUB_CLIENT_ID|GITHUB_APP_ID|GITHUB_ID|AUTH_GITHUB_ID)$/, "a GitHub OAuth app"],
  [/^(GOOGLE_CLIENT_ID|AUTH_GOOGLE_ID)$/, "a Google OAuth app"], [/^DISCORD_(BOT_)?TOKEN$/, "a Discord bot"], [/^SLACK_(BOT_)?TOKEN$/, "a Slack app"], [/^TELEGRAM_BOT_TOKEN$/, "a Telegram bot"],
  [/^CLERK_SECRET_KEY$/, "Clerk"], [/^AUTH0_(CLIENT_ID|DOMAIN)$/, "Auth0"], [/^(NEXT_PUBLIC_)?MAPBOX_\w*TOKEN$/, "Mapbox"], [/^ALGOLIA_(APP_ID|API_KEY)$/, "Algolia"], [/^UPSTASH_REDIS_REST_URL$/, "Upstash"],
];
const LOCAL_AI = /\b(ollama|llama\.cpp|llamacpp|llama-cpp|lm ?studio|localai|vllm|OLLAMA_[A-Z_]+|LOCAL_LLM|text-generation-webui)\b/i;

// ── Lock files ────────────────────────────────────────────────────────────────────────────────────────────────────
const LOCKFOR: [string, RegExp][] = [
  ["package.json", /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/],
  ["pyproject.toml", /^(poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|requirements[\w.-]*\.txt)$/],
  ["Pipfile", /^Pipfile\.lock$/],
  ["Cargo.toml", /^Cargo\.lock$/],
  ["go.mod", /^go\.sum$/],
  ["Gemfile", /^Gemfile\.lock$/],
  ["composer.json", /^composer\.lock$/],
];

// ── The checks ────────────────────────────────────────────────────────────────────────────────────────────────────
export type SetupInput = {
  facts: Facts;
  files: Files;
  link: (path: string, line?: number) => string;
  requested?: string;
};

export function setupFindings({ facts, files: f, link }: SetupInput): { findings: Finding[]; kind: ReturnType<typeof projectKind>; steps: SetupStep[] } {
  const out: Finding[] = [];
  const add = (x: Finding) => out.push(x);
  const ev = (path: string, line?: number): Evidence => ({ label: line ? `${path}:${line}` : path, url: link(path, line), path, line });
  const deps = directDeps(f);
  const kind = projectKind(f, deps, facts);
  const applies = (check: keyof typeof APPLIES) => APPLIES[check].includes(kind.kind);
  const docs = docsOf(f);
  const docText = docs.map((d) => f.files[d]).join("\n");
  const allDocs = Object.entries(f.files).filter(([p]) => DOC.test(p)).map(([, t]) => t).join("\n");
  const repoName = facts.repo.fullName.split("/")[1];
  const has = (re: RegExp) => f.paths.some((p) => re.test(p));

  add({ id: "setup.kind", section: "setup", level: "neutral", status: "info", kind: "detected", title: `Looks like ${kind.label}`, text: `It looks like ${kind.label} (${kind.why}), so the checks below are the ones that fit that kind of project.` });
  const skippedChecks = (Object.keys(APPLIES) as (keyof typeof APPLIES)[]).filter((c) => !applies(c)).map((c) => NAME[c]);
  if (skippedChecks.length)
    add({ id: "setup.na", section: "setup", level: "neutral", status: "n/a", kind: "detected", title: "Not applicable", text: `Not checked because they don't apply to ${kind.label}: ${list(skippedChecks, 6)}.` });
  if (kind.kind === "docs") return { findings: out, kind, steps: [] };

  // 1. Do the documented steps match the repo?
  const cmds = commands(f, repoName, docs);
  const { missing, checked } = checkCommands(f, cmds, deps, repoName);
  const steps = cmds.filter((c) => !c.inline).length;
  const scripts = missing.filter((m) => m.what === "script");
  const targets = missing.filter((m) => m.what === "target");
  // A library's docs show users how to containerise their own app (FastAPI): no Dockerfile of its own is expected.
  const absent = missing.filter((m) => (m.what === "file" || m.what === "manifest" || m.what === "lock") && !(m.what === "manifest" && /Docker/.test(m.detail) && kind.kind !== "app" && kind.kind !== "template"));
  // Scripts are looked up in the package.json files read. When the repo was too large to read in full, only the main
  // ones were, so a script the docs run may sit in a workspace package: a concern to check, never a blocker.
  const manifests = Object.keys(f.files).filter((p) => /(^|\/)package\.json$/.test(p));
  const allManifests = f.paths.filter((p) => /(^|\/)package\.json$/.test(p) && !/(^|\/)node_modules\//.test(p));
  if (scripts.length && !f.whole) {
    const s = scripts[0];
    add({
      id: "setup.scripts",
      section: "setup",
      level: "note",
      priority: "important",
      kind: "detected",
      title: scripts.length === 1 ? `"${s.detail}" script not found in the manifests read` : `${scripts.length} documented scripts not found in the manifests read`,
      text: `${scripts.length === 1 ? `${s.doc} runs the "${s.detail}" script (line ${s.line})` : `The docs run ${list(scripts.map((x) => `"${x.detail}" (${x.doc}:${x.line})`))}`}, but ${manifests.length === 1 ? `${manifests[0]}, the only package.json read,` : `the ${manifests.length} package.json files read`} ${scripts.length === 1 ? "doesn't define it" : "don't define them"}. The repo has ${plural(allManifests.length, "package.json file")} and was too large to read in full, so ${scripts.length === 1 ? "it" : "they"} may be defined in one that wasn't read.`,
      evidence: [...scripts.slice(0, 3).map((x) => ev(x.doc, x.line)), ...manifests.slice(0, 1).map((p) => ev(p))],
      action: "Check whether the step is still needed: search the repo's package.json files for the script name before following that step.",
    });
  } else if (scripts.length) {
    const s = scripts[0];
    add({
      id: "setup.scripts",
      section: "setup",
      level: "risk",
      priority: "blocker",
      kind: "detected",
      title: scripts.length === 1 ? `"${s.detail}" script doesn't exist` : `${scripts.length} documented scripts don't exist`,
      text:
        scripts.length === 1
          ? `${s.doc} runs the "${s.detail}" script (line ${s.line}), but none of the repo's ${plural(manifests.length, "package.json file")} defines it, so that step would fail with "Missing script". Not run to confirm.`
          : `The docs run scripts that none of the repo's ${plural(manifests.length, "package.json file")} defines: ${list(scripts.map((x) => `"${x.detail}" (${x.doc}:${x.line})`))}. Those steps would fail with "Missing script". Not run to confirm.`,
      evidence: [...scripts.slice(0, 3).map((x) => ev(x.doc, x.line)), ...(f.files["package.json"] ? [ev("package.json")] : [])],
      action: "Check whether the step is still needed: look at the scripts in package.json for its current name, or the repo's issues for updated instructions.",
    });
  }
  if (targets.length)
    add({
      id: "setup.make",
      section: "setup",
      level: "risk",
      priority: "blocker",
      kind: "detected",
      title: targets.length === 1 ? `"make ${targets[0].detail}" has no target` : `${targets.length} make targets missing`,
      text: `The docs run ${list(targets.map((x) => `"make ${x.detail}" (${x.doc}:${x.line})`))}, but the Makefile has no such target.`,
      evidence: [...targets.slice(0, 3).map((x) => ev(x.doc, x.line)), ...Object.keys(f.files).filter((p) => MAKEFILE.test(p)).slice(0, 1).map((p) => ev(p))],
      action: "Run `make help` or read the Makefile for the current target names.",
    });
  if (absent.length)
    add({
      id: "setup.files",
      section: "setup",
      level: "risk",
      priority: "blocker",
      kind: "detected",
      title: absent.length === 1 ? `${absent[0].detail} is missing` : `${absent.length} files the steps use are missing`,
      text:
        absent.length === 1
          ? `${absent[0].doc} (line ${absent[0].line}) uses ${absent[0].detail}, which isn't in the repo${absent[0].what === "file" ? " and isn't created by an earlier step" : ""}.`
          : `Setup steps use files that aren't in the repo and aren't created by an earlier step: ${list(absent.map((x) => `${x.detail} (${x.doc}:${x.line})`))}.`,
      evidence: absent.slice(0, 4).map((x) => ev(x.doc, x.line)),
      action: "Search the repo and its issues for where these files moved; the docs may be out of date.",
    });
  if (!missing.length && checked >= 3)
    add({ id: "setup.steps", section: "setup", level: "good", kind: "detected", title: "Documented steps match the repo", text: `All ${checked} scripts, make targets and files the setup steps use exist in the repo. The steps weren't run.`, evidence: docs.slice(0, 1).map((d) => ev(d)) });
  else if (!steps && !cmds.length)
    add({
      id: "setup.nosteps",
      section: "setup",
      level: kind.kind === "library" ? "neutral" : "note",
      status: "not-found",
      kind: "detected",
      title: "No setup commands found",
      text: `Not found in the files read: setup commands in the README or other setup docs${docs.length ? ` (${list(docs.slice(0, 3))} were read)` : ""}. You'll have to work out the steps from the files.`,
      action: "Look for a Dockerfile, Makefile or scripts in package.json that show how it's built and run.",
    });

  // Steps only in the contributor or build-from-source docs don't block installing it: an improvement, said so.
  const contribOnly = (id: string, ms: Missing[]) => {
    const x = out.find((o) => o.id === id);
    if (!x || !ms.length || !ms.every((m) => m.contrib)) return;
    Object.assign(x, {
      level: "note",
      priority: "improvement",
      title: `${x.title} (contributor docs)`,
      text: `${x.text} These are contributor or build-from-source steps; installing a release isn't affected.`,
    });
  };
  contribOnly("setup.scripts", scripts);
  contribOnly("setup.make", targets);
  contribOnly("setup.files", absent);

  // 2. Versions: docs against the files.
  const req = requiredVersions(f);
  const conflicts: { text: string; evidence: Evidence[] }[] = [];
  const compare = (name: string, required: Required[], documented: Version[]) => {
    // Ranges (engines, requires-python, go.mod) set the minimum; pins (.nvmrc, a Dockerfile's image) pick one version.
    // A conflict is the docs or a pin going below that minimum. A pin above it is just the version they use.
    const ranges = required.filter((r) => !r.pin);
    if (!ranges.length) return;
    const strictest = [...ranges].sort((a, b) => b.low[0] - a.low[0] || (b.low[1] ?? 0) - (a.low[1] ?? 0))[0];
    const low = documented.filter((d) => below(d, strictest.low)).sort((a, b) => a.major - b.major || (a.minor ?? 0) - (b.minor ?? 0))[0];
    if (low) conflicts.push({ text: `${low.source} says ${low.text} (line ${low.line}), but ${strictest.source} requires ${name} ${strictest.range}.`, evidence: [ev(low.source, low.line), ev(strictest.source, strictest.line)] });
    const clash = required.find((r) => r.pin && (r.low[0] < strictest.low[0] || (r.low[0] === strictest.low[0] && r.low[1] !== null && strictest.low[1] !== null && r.low[1] < strictest.low[1])));
    if (clash) conflicts.push({ text: `${clash.source} picks ${name} ${clash.range}, but ${strictest.source} requires ${strictest.range}.`, evidence: [ev(clash.source, clash.line), ev(strictest.source, strictest.line)] });
  };
  compare("Node.js", req.node, documentedVersions(f, docs, /\b(?:node(?:\.?js)?|nodejs)\s*(?:version\s*|v)?(?:>=|≥|\^|~)?\s*v?(\d{1,2})(?:\.(\d{1,2}))?(?:\.\d+)?(?![\d.])/gi, (m) => m >= 4 && m <= 40).concat(documentedVersions(f, docs, /\bnvm (?:install|use) v?(\d{1,2})(?:\.(\d{1,2}))?/g, () => true)));
  compare("Python", req.python, documentedVersions(f, docs, /\bpython\s*(?:version\s*)?(?:>=|≥|v)?\s*3\.(\d{1,2})(?![\d])/gi, () => true).map((v) => ({ ...v, minor: v.major, major: 3 })));
  compare("Go", req.go, documentedVersions(f, docs, /\bgo\s*(?:version\s*)?(?:>=|v)?\s*1\.(\d{1,2})(?![\d])/gi, (m) => m < 21) /* Go 1.21+ fetches the version go.mod asks for */.map((v) => ({ ...v, minor: v.major, major: 1 })));
  if (conflicts.length)
    add({
      id: "setup.versions",
      section: "setup",
      level: "note",
      priority: "important", // the files win, so it's out-of-date docs, not a step that fails
      kind: "detected",
      title: "Docs and files disagree on versions",
      text: conflicts.map((c) => c.text).join(" "),
      evidence: conflicts.flatMap((c) => c.evidence).slice(0, 4),
      action: "Use the version the files require; the docs are likely out of date.",
    });

  // 3. Package manager: the docs' install command against the lock file.
  const LOCKS: [RegExp, string][] = [[/^pnpm-lock\.yaml$/, "pnpm"], [/^yarn\.lock$/, "yarn"], [/^bun\.lockb?$/, "bun"], [/^package-lock\.json$/, "npm"]];
  const pinned = /"packageManager"\s*:\s*"(npm|pnpm|yarn|bun)@/.exec(f.files["package.json"] ?? "")?.[1];
  const locked = LOCKS.filter(([re]) => f.paths.some((p) => re.test(p))).map(([, n]) => n);
  const meant = pinned ?? (locked.length === 1 ? locked[0] : null);
  if (meant && f.files["package.json"]) {
    // Only installs of the repo itself: not global tools (`npm i -g x`), uninstalls or npx.
    const installs = cmds.filter((c) => !c.inline && !c.contrib && c.cwd === "" && !c.argv.some((x) => x === "-g" || x === "--global") && ((c.argv[0] === "npm" && /^(install|i|ci)$/.test(c.argv[1] ?? "") && c.argv.length <= 3) || (/^(pnpm|bun)$/.test(c.argv[0]) && /^(install|i)$/.test(c.argv[1] ?? "") && c.argv.length <= 3) || (c.argv[0] === "yarn" && (c.argv.length === 1 || c.argv[1] === "install"))));
    const used = new Set(installs.map((c) => c.argv[0]));
    const first = installs.find((c) => c.argv[0] !== meant);
    if (used.size === 1 && !used.has(meant) && first)
      add({
        id: "setup.manager",
        section: "setup",
        level: "note",
        priority: "important",
        kind: "detected",
        title: `Docs use ${first.argv[0]}, the repo uses ${meant}`,
        text: `${first.doc} installs with ${first.argv[0]} (line ${first.line}), but the repo is set up for ${meant} (${pinned ? `"packageManager" in package.json` : f.paths.find((p) => LOCKS.find(([, n]) => n === meant)![0].test(p))}). ${first.argv[0]} ignores that lock file, so you may get different versions than the maintainers test with.`,
        evidence: [ev(first.doc, first.line), ev(pinned ? "package.json" : f.paths.find((p) => LOCKS.find(([, n]) => n === meant)![0].test(p))!)],
        action: `Install with ${meant} instead${meant !== "npm" ? ` (\`npm install -g ${meant}\` or \`corepack enable\`)` : ""}.`,
      });
  }

  // 4. Settings the code reads.
  if (!applies("config")) {
    /* not applicable */
  } else if (!f.whole)
    add({ id: "config.env", section: "config", level: "neutral", status: "not-checked", kind: "detected", title: "Settings not checked", text: "The repo was too large to read in full, so the settings its code reads weren't checked." });
  else {
    const reads = envReads(f);
    // A monorepo's packages each read their own settings, many for optional features: reported, not counted against it.
    const packages = Object.keys(f.files).filter((p) => /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod)$/.test(p) && !NOT_APP_CODE.test(p)).length;
    const mono = packages >= 5;
    const examples = Object.keys(f.files).filter((p) => ENV_EXAMPLE.test(p) && !NOT_APP_CODE.test(p) && !/[._-](test|ci|e2e|spec)[._-]/i.test(p.split("/").pop()!)).sort(byDepth);
    const inExample = new Set(examples.flatMap((p) => [...f.files[p].matchAll(/^\s*#?\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm)].map((m) => m[1])));
    const mentioned = new Set<string>();
    for (const [p, t] of Object.entries(f.files)) if (CONFIG.test(p) && !CODE.test(p)) for (const m of t.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) mentioned.add(m[0]);
    const undocumented = reads.filter((r) => !inExample.has(r.name) && !mentioned.has(r.name) && !/^(TEST|E2E|CI|MOCK)_/.test(r.name));
    const required = undocumented.filter((r) => !r.fallback);
    if (reads.length && !undocumented.length)
      add({ id: "config.env", section: "config", level: "good", kind: "detected", title: "Settings are documented", text: `All ${plural(reads.length, "setting")} the code reads from the environment appear in ${examples[0] ?? "its docs or config files"}.`, evidence: examples.slice(0, 1).map((p) => ev(p)) });
    else if (undocumented.length) {
      const shown = [...required, ...undocumented.filter((r) => r.fallback)];
      add({
        id: "config.env",
        section: "config",
        level: mono || !required.length ? "neutral" : "note",
        status: required.length && !mono ? "concern" : "info",
        priority: required.length && !mono ? "improvement" : undefined, // reading a setting isn't needing it: never more
        kind: "detected",
        title: examples.length ? `${plural(undocumented.length, "setting")} missing from ${examples[0].split("/").pop()}` : `${plural(undocumented.length, "undocumented setting")}`,
        text: `${mono ? `Across its ${packages} packages, the` : "The"} code reads ${plural(undocumented.length, "setting")} that ${undocumented.length === 1 ? "isn't" : "aren't"} in ${examples.length ? examples[0] : "an example settings file"} or mentioned in the docs: ${list(shown.map((r) => r.name), 6)}.${required.length ? ` ${required.length === undocumented.length ? (required.length === 1 ? "It's" : "All are") : `${required.length} of them are`} read with no default in the code; ${required.length === 1 ? "it may be optional" : "many may be optional"}, but check before relying on the defaults.` : " Each has a default in the code."}`,
        evidence: shown.slice(0, 4).map((r) => ev(r.path, r.line)),
        action: `Search the code for each name to see what it expects${examples.length ? `, and add them to your copy of ${examples[0].split("/").pop()}` : ""}.`,
      });
    }
    if (kind.kind === "app" && !examples.length && reads.filter((r) => !r.fallback).length >= 3 && undocumented.length < reads.length)
      add({ id: "config.example", section: "config", level: "note", status: "not-found", priority: "improvement", kind: "detected", title: "No example settings file", text: `Not found in the files read: an example settings file (.env.example or similar), though the code reads ${plural(reads.length, "setting")}.` });

    // Accounts you'll need. Required means the main code reads the key with no default; with several AI providers
    // to choose from, you need one of them, not all.
    const names = new Map<string, { service: string; ai: boolean; required: boolean; ev: Evidence }>();
    const exampleUse = examples.flatMap((p) => [...f.files[p].matchAll(/^\s*(#)?\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm)].map((m) => ({ name: m[2], path: p, line: lines(f.files[p], m.index!) })));
    for (const r of reads) {
      const hit = ACCOUNTS.find(([re]) => re.test(r.name));
      if (!hit) continue;
      // In a monorepo, a key counts as required only when the docs or example settings also name it.
      // Framework driver configs (Laravel's config/*.php) list every optional driver, and a key behind an
      // "…_ENABLED" switch is only needed when it's switched on.
      const switched = /\b[A-Z][A-Z0-9_]*_ENABLED?\b|\bENABLE_[A-Z0-9_]+\b/.test(f.files[r.path] ?? "");
      const required = !r.fallback && !INTEGRATION.test(r.path) && !/(^|\/)config\/[^/]+\.php$/.test(r.path) && !switched && (!mono || inExample.has(r.name) || docText.includes(r.name));
      const was = names.get(hit[1]);
      if (!was || (!was.required && required)) names.set(hit[1], { service: hit[1], ai: Boolean(hit[2]), required, ev: ev(r.path, r.line) });
    }
    for (const e of exampleUse) {
      const hit = ACCOUNTS.find(([re]) => re.test(e.name));
      if (hit && !names.has(hit[1])) names.set(hit[1], { service: hit[1], ai: Boolean(hit[2]), required: false, ev: ev(e.path, e.line) });
    }
    const accounts = [...names.values()];
    const aiRequired = accounts.filter((a) => a.ai && a.required);
    const appCode = Object.entries(f.files).filter(([p]) => CODE.test(p) && !NOT_APP_CODE.test(p)).slice(0, 2000).map(([, t]) => t).join("\n").slice(0, 3_000_000);
    const local = LOCAL_AI.exec(docText) ?? LOCAL_AI.exec(appCode);
    // A choice of providers, and none needed at all when a local model is an option.
    const pickOne = aiRequired.length >= 3 && !local;
    const req2 = accounts.filter((a) => a.required && !(a.ai && (aiRequired.length >= 3 || local)));
    const optional = accounts.filter((a) => !a.required || (a.ai && local && !req2.includes(a)));
    const needAi = aiRequired.length > 0;
    if (accounts.length)
      add({
        id: "services.accounts",
        section: "services",
        headline: "cost",
        level: req2.length || pickOne ? "note" : "neutral",
        status: req2.length || pickOne ? "concern" : "info",
        priority: req2.length || pickOne ? "important" : undefined,
        kind: "detected",
        title: req2.length ? `Needs ${req2.length === 1 ? `${/^an? /.test(req2[0].service) ? req2[0].service : `a ${req2[0].service}`} account` : `${req2.length} outside accounts`}` : pickOne ? "Needs an AI provider account" : "Optional outside services",
        text: [
          req2.length && `You'll need ${list(req2.map((a) => a.service))}: the main code reads ${req2.length === 1 ? "its key" : "their keys"} with no default.`,
          pickOne && `It works with ${list(aiRequired.map((a) => a.service))}; you'll need an account with at least one.`,
          optional.length && `It can also use ${list(optional.map((a) => a.service))}, which you can likely leave out.`,
          needAi && (local ? `A local model (${local[0]}) is mentioned, so it may run without a paid AI account.` : "No local model option was found, so it can't run fully offline."),
          (req2.length || pickOne) && "Some of these bill per use.",
        ]
          .filter(Boolean)
          .join(" "),
        evidence: [...req2, ...aiRequired, ...optional].filter((a, i, all) => all.indexOf(a) === i).slice(0, 4).map((a) => a.ev),
        action: req2.length || pickOne ? "Create the accounts and keys before you start, and set a spending limit on any that bill per use." : undefined,
      });
  }

  // 5. Databases and other services.
  if (applies("services")) {
    const composeFiles = Object.keys(f.files).filter((p) => COMPOSE.test(p) && !NOT_APP_CODE.test(p)).sort(byDepth);
    const appReads = f.whole ? envReads(f).filter((r) => !r.fallback && !INTEGRATION.test(r.path)) : [];
    const exampleNames = Object.entries(f.files).filter(([p]) => ENV_EXAMPLE.test(p) && !MINOR_DIR.test(p)).flatMap(([p, t]) => [...t.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(\S*)/gm)].map((m) => ({ name: m[1], value: m[2], path: p, line: lines(t, m.index!) })));
    const composed = composeFiles.flatMap((p) => composeServices(f.files[p]).map((s) => ({ ...s, file: p })));
    const composeDocumented = /docker[- ]compose\s+(up|run|start)|docker compose\s+(-f\s+\S+\s+)?(up|run|start)|podman[- ]compose/i.test(allDocs) || cmds.some((c) => (c.argv[0] === "docker" && c.argv[1] === "compose") || c.argv[0] === "docker-compose");
    const prisma = Object.entries(f.files).find(([p]) => /schema\.prisma$/.test(p) && !MINOR_DIR.test(p));
    const prismaProvider = prisma ? /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(prisma[1])?.[1] : undefined;
    const missingSvc: { name: string; why: Evidence }[] = [];
    const dbClients = SERVICES.filter((x) => (x.sql || x.name === "MongoDB") && x.deps.some((d) => deps.get(d.toLowerCase()) && !deps.get(d.toLowerCase())!.dev)).length;
    const sqlite = ["sqlite3", "better-sqlite3", "aiosqlite", "@libsql/client", "libsql", "sqlx", "rusqlite", "github.com/mattn/go-sqlite3", "modernc.org/sqlite"].some((d) => deps.has(d)) || /DATABASE_URL[^\n]{0,80}sqlite/i.test(Object.entries(f.files).filter(([p]) => CODE.test(p) && !NOT_APP_CODE.test(p)).map(([, t]) => (t.includes("DATABASE_URL") ? t : "")).join("\n"));
    const quietCompose: { name: string; file: string; line: number }[] = [];
    const ok: string[] = [];
    for (const s of SERVICES) {
      if (facts.repo.fullName.toLowerCase().includes(s.name.toLowerCase())) continue; // the service's own repo
      // A client library alone isn't proof it's needed (integration platforms list dozens). It also needs a sign it's
      // expected to be there: a connection setting the main code reads, one in the example settings, Prisma pointing
      // at it, or a Compose file starting it.
      const depHit = s.deps.map((d) => [d, deps.get(d.toLowerCase())] as const).find(([, d]) => d && !d.dev && !INTEGRATION.test(d.file));
      const viaPrisma = s.prisma && prismaProvider === s.prisma;
      const inCompose = composed.find((c) => (c.image && s.image.test(c.image)) || s.image.test(c.name));
      // DATABASE_URL names a database only when one kind of client is installed and SQLite isn't an option.
      const shared = (name: string) => name === "DATABASE_URL" && (dbClients > 1 || sqlite);
      const setting = appReads.find((r) => s.env.test(r.name) && !shared(r.name) && (r.name !== "DATABASE_URL" || depHit)) ?? exampleNames.find((e) => (s.env.test(e.name) && !shared(e.name) && (e.name !== "DATABASE_URL" || depHit)) || (s.url && s.url.test(e.value)));
      if (!viaPrisma && !((depHit || (setting && s.url?.test("value" in setting ? setting.value : ""))) && (setting || inCompose))) continue;
      const why = viaPrisma ? ev(prisma![0]) : setting ? ev(setting.path, setting.line) : ev(depHit![1]!.file, depHit![1]!.line);
      const documented = s.docs.test(docText);
      if (inCompose && (composeDocumented || documented)) ok.push(`${s.name} (started by ${inCompose.file})`);
      else if (documented) ok.push(`${s.name} (described in the docs)`);
      else if (inCompose) quietCompose.push({ name: s.name, file: inCompose.file, line: inCompose.line });
      else missingSvc.push({ name: s.name, why });
    }
    if (missingSvc.length)
      add({
        id: "services.missing",
        section: "services",
        // Undocumented, not proven missing: the code may run without it, or the docs may live elsewhere.
        level: "note",
        priority: "important",
        kind: "detected",
        title: missingSvc.length === 1 ? `${missingSvc[0].name} needed, not in the docs` : `${missingSvc.length} services needed, not in the docs`,
        text: `The code uses ${list(missingSvc.map((s) => `${s.name} (${s.why.label})`))}, but the setup docs don't mention installing or starting ${missingSvc.length === 1 ? "it" : "them"}, and no Compose file starts ${missingSvc.length === 1 ? "it" : "them"}.`,
        evidence: missingSvc.slice(0, 3).map((s) => s.why),
        action: `Have ${list(missingSvc.map((s) => s.name))} running before you start it, and find the connection setting (often a *_URL variable) it expects.`,
      });
    if (quietCompose.length)
      add({
        id: "services.compose",
        section: "services",
        level: "note",
        priority: "improvement",
        kind: "detected",
        title: "Compose starts services the docs don't mention",
        text: `${quietCompose[0].file} starts ${list(quietCompose.map((s) => s.name))}, but the setup docs never say to run Docker Compose or mention ${quietCompose.length === 1 ? "it" : "them"}.`,
        evidence: quietCompose.slice(0, 3).map((s) => ev(s.file, s.line)),
        action: `Start them with \`docker compose -f ${quietCompose[0].file} up -d\` before running the app.`,
      });
    if (ok.length && !missingSvc.length && !quietCompose.length)
      add({ id: "services.ok", section: "services", level: "good", kind: "detected", title: `${plural(ok.length, "service")} accounted for`, text: `It needs ${list(ok)}.` });

    // Databases: is there a step that creates the tables?
    // The project's own migrations: not an example's (Next.js) or a test mock's (Actual).
    const migrations = f.paths.find((p) => /(^|\/)(prisma\/migrations|alembic|db\/migrate|migrations|drizzle|db\/migrations?|database\/migrations|supabase\/migrations)\/[^/]+/.test(p) && !/(^|\/)(node_modules|vendor|__mocks__|mocks?)\//.test(p) && !MINOR_DIR.test(p));
    const tool =
      prisma ? "Prisma" : has(/(^|\/)alembic\.ini$/) ? "Alembic" : has(/(^|\/)manage\.py$/) && migrations?.includes("migrations/") ? "Django" : has(/(^|\/)db\/migrate\//) ? "Rails" : has(/(^|\/)drizzle\.config\.[jt]s$/) ? "Drizzle" : has(/(^|\/)knexfile\.[jt]s$/) ? "Knex" : migrations ? "migration" : null;
    if (tool && (migrations || prisma)) {
      const RUN = /prisma\s+(migrate|db\s+push)|alembic\s+upgrade|manage\.py\s+migrate|rails\s+db:(migrate|setup|prepare|create)|rake\s+db:|drizzle-kit\s+(push|migrate)|knex\s+migrate|sequelize(-cli)?\s+db:migrate|\bmigrate\s+(up|deploy|-path)|goose\s+up|\bdb:(migrate|push|setup|init)\b|run\s+(db:\w+|migrate\w*)|\bmigrations?\b.*\b(run|apply)|\b(run|apply)\b.*\bmigrations?\b/i;
      // Install and start scripts that run them: package.json, and composer.json (Laravel runs `artisan migrate`).
      const pkgScripts = Object.entries(f.files).filter(([p]) => p.endsWith("package.json")).flatMap(([, t]) => Object.entries(json(t)?.scripts ?? {}) as [string, string][]);
      const composerScripts = Object.entries(json(f.files["composer.json"])?.scripts ?? {}).map(([k, v]) => [k, ([] as unknown[]).concat(v).join(" && ")] as [string, string]);
      const auto = [...pkgScripts, ...composerScripts].find(([name, cmd]) => /^(pre)?(start|dev|build|postinstall|prestart|predev|setup|bootstrap|post-create-project-cmd|post-install-cmd|post-root-package-install)$/.test(name) && (RUN.test(cmd) || /artisan\s+migrate/.test(cmd)));
      const entry = Object.entries(f.files).find(([p, t]) => (DOCKERFILE.test(p) || COMPOSE.test(p) || /(^|\/)(entrypoint|docker-entrypoint|start|run|init)[\w-]*\.sh$/.test(p) || /(^|\/)bin\/docker-entrypoint$/.test(p) || /(^|\/)Procfile$/.test(p)) && (RUN.test(t) || /docker-entrypoint-initdb\.d/.test(t)));
      // Code that migrates when the app starts: Go's goose, Rust's sqlx and diesel, TypeORM, Knex, Sequelize and others.
      // Not for Rails, where "migrate" is a common word (Mastodon's account migrations) and the steps run db:prepare.
      const inCode =
        tool === "Rails"
          ? undefined
          : Object.entries(f.files).find(([p, t]) => CODE.test(p) && !NOT_APP_CODE.test(p) && /\b((db|database|knex|sequelize|umzug|migrator|orm|dataSource)\.migrate\(|runMigrations|AutoMigrate\(|create_all\(|sequelize\.sync\(|synchronize:\s*true|migrationsRun:\s*true|migrator\.up|\.migrate\.latest\(|run_migrations|run_pending_migrations|migrateLatest|goose\.(Up|UpContext|Run)\(|sqlx::migrate!|embed_migrations!|MigrateDatabase|migrate\.New(WithSourceInstance)?\()/.test(t));
      const documented = RUN.exec(docText) ?? RUN.exec(allDocs);
      const where = migrations ?? prisma?.[0] ?? "";
      if (documented || auto || entry || inCode)
        add({ id: "setup.migrations", section: "setup", level: "good", kind: "detected", title: "Database setup step found", text: `${tool === "migration" ? "Database migrations" : `${tool} migrations`} ${documented ? "are run by a documented step" : auto ? `run automatically from the "${auto[0]}" script` : entry ? `run from ${entry[0]}` : `run when the app starts (${inCode![0]})`}.`, evidence: [documented ? (() => { const d = docs.find((x) => RUN.test(f.files[x])) ?? Object.keys(f.files).find((x) => DOC.test(x) && RUN.test(f.files[x]))!; return ev(d, lines(f.files[d], RUN.exec(f.files[d])!.index)); })() : ev(auto ? (composerScripts.includes(auto) ? "composer.json" : "package.json") : entry ? entry[0] : inCode![0])] });
      else
        add({
          id: "setup.migrations",
          section: "setup",
          // A blocker only when the whole repo was read; a template's own scripts set it up when you create from it.
          level: f.whole && kind.kind !== "template" ? "risk" : "note",
          priority: f.whole && kind.kind !== "template" ? "blocker" : kind.kind === "template" ? "improvement" : "important",
          kind: "detected",
          title: "No step creates the database tables",
          text: `It has ${tool === "migration" ? "database migrations" : `${tool} migrations`}${where ? ` (${where.split("/").slice(0, -1).join("/") || where})` : ""}, but no documented step, start script or container entry point runs them that was found in the files read. Until they run, the database has no tables.`,
          evidence: where ? [ev(where)] : undefined,
          action: tool === "Prisma" ? "Run `npx prisma migrate deploy` (or `npx prisma db push`) after the database is up." : tool === "Alembic" ? "Run `alembic upgrade head` after the database is up." : tool === "Django" ? "Run `python manage.py migrate` after the database is up." : tool === "Rails" ? "Run `bin/rails db:prepare` after the database is up." : "Find the migration command in package.json, the Makefile or the docs, and run it after the database is up.",
        });
    }
  }

  // 6. Requirements: runtimes, platforms, hardware, as documented or required.
  const runtime: string[] = [];
  const reqEv: Evidence[] = [];
  const RUNTIME_NAME: Record<string, string> = { node: "Node.js", python: "Python", go: "Go", rust: "Rust", ruby: "Ruby", php: "PHP" };
  for (const [k, v] of Object.entries(req) as [keyof typeof req, Required[]][])
    if (v.length) {
      const top = [...v].sort((a, b) => b.low[0] - a.low[0] || (b.low[1] ?? 0) - (a.low[1] ?? 0))[0];
      runtime.push(`${RUNTIME_NAME[k]} ${/^[\d.]+$/.test(top.range) ? top.range : top.range.replace(/\s+/g, " ")} (${top.source})`);
      reqEv.push(ev(top.source, top.line));
    }
  const pm = /"packageManager"\s*:\s*"([\w-]+)@(\d+)/.exec(f.files["package.json"] ?? "");
  if (pm) runtime.push(`${pm[1]} ${pm[2]}`);
  const assets = (facts.releases ?? []).filter((r) => !r.prerelease).slice(0, 2).flatMap((r) => r.assets);
  const os = [/darwin|macos|mac-?os|osx|apple|\.dmg$|\.pkg$/i.test(assets.join(" ")) && "macOS", /windows|win(32|64)|\.exe$|\.msi$|\bwin\b/i.test(assets.join(" ")) && "Windows", /linux|\.deb$|\.rpm$|\.appimage$|musl|gnu/i.test(assets.join(" ")) && "Linux"].filter(Boolean) as string[];
  const arch = [/arm64|aarch64|apple-?silicon|universal/i.test(assets.join(" ")) && "ARM", /x86_64|amd64|x64|intel|universal/i.test(assets.join(" ")) && "x86-64"].filter(Boolean) as string[];
  const memory = /\b(\d+(?:\.\d+)?)\s?(GB|GiB|MB)\s+(?:of\s+)?(?:free\s+)?(RAM|memory|VRAM|GPU memory|disk(?: space)?|storage|free space)\b/i.exec(docText);
  const memDoc = memory ? docs.find((d) => f.files[d].includes(memory[0])) : undefined;
  if (runtime.length || os.length || memory)
    add({
      id: "requirements.summary",
      section: "requirements",
      level: "neutral",
      kind: memory && !runtime.length ? "documented" : "detected",
      title: runtime.length ? runtime[0].replace(/ \(.*$/, "") : os.length ? `Downloads for ${list(os)}` : "Hardware",
      text: [
        runtime.length && `Needs ${list(runtime, 6)}.`,
        os.length && `Release downloads exist for ${list(os)}${arch.length ? ` (${list(arch)})` : ""}.`,
        memory && `The docs mention "${memory[0]}" (${memDoc}).`,
      ]
        .filter(Boolean)
        .join(" "),
      evidence: [...reqEv.slice(0, 3), ...(memDoc ? [ev(memDoc, lines(f.files[memDoc], f.files[memDoc].indexOf(memory![0])))] : [])],
    });
  else if (has(DOCKERFILE))
    add({ id: "requirements.summary", section: "requirements", level: "neutral", kind: "detected", title: "Docker", text: "No runtime version is set in its files; it ships a Dockerfile, so Docker is the surest way to run it.", evidence: [ev(f.paths.find((p) => DOCKERFILE.test(p))!)] });

  // 7. Lock files.
  if (applies("lockfile")) {
    const manifestsAtRoot = LOCKFOR.filter(([m]) => f.paths.includes(m));
    // A pyproject.toml with no dependencies of its own has nothing to lock.
    const unlocked = manifestsAtRoot.filter(([name, lock]) => !f.paths.some((p) => !p.includes("/") && lock.test(p)) && !(name === "pyproject.toml" && !/dependencies\s*=\s*\[\s*["']|\[tool\.poetry\.dependencies\]/.test(f.files["pyproject.toml"] ?? "")));
    if (manifestsAtRoot.length)
      add(
        unlocked.length
          ? { id: "deps.lockfile", section: "dependencies", level: "note", priority: "improvement", kind: "detected", title: "No lock file", text: `Not found in the files read: a lock file for ${list(unlocked.map(([n]) => n))}. Without one, each install can pick up newer versions of its dependencies than the maintainers tested.`, evidence: unlocked.slice(0, 2).map(([n]) => ev(n)), action: "Pin the versions you test with, or install from a tagged release." }
          : (() => {
              const locks = f.paths.filter((p) => !p.includes("/") && LOCKFOR.some(([, l]) => l.test(p)) && !/^requirements/.test(p));
              const pinned = f.paths.filter((p) => !p.includes("/") && /^requirements[\w.-]*\.txt$/.test(p));
              return locks.length
                ? { id: "deps.lockfile", section: "dependencies", level: "good", kind: "detected", title: "Versions locked", text: `Dependency versions are locked (${list(locks)}), so installs match what the maintainers use.` }
                : { id: "deps.lockfile", section: "dependencies", level: "neutral", kind: "detected", title: "Versions pinned in requirements", text: `${list(pinned)} lists the versions to install; there's no separate lock file.` };
            })() as Finding,
      );
  }

  // 8. Which vulnerable packages it uses directly.
  // The project itself isn't one of its flawed dependencies (Flask's lock lists Flask).
  const self = new Set([norm(repoName), ...[...ownNames(f.files, facts.repo.fullName)].map((n) => norm(n.replace(/^[^:]+:/, "")))]);
  const vuln = (facts.deps?.vulnerable ?? []).filter((v) => !self.has(norm(v.name)));
  if (vuln.length) {
    const direct = vuln.filter((v) => deps.get(v.name.toLowerCase()) && !deps.get(v.name.toLowerCase())!.dev);
    const dev = vuln.filter((v) => deps.get(v.name.toLowerCase())?.dev);
    // Important only for a high or critical flaw in something it ships; low, moderate or unrated ones are worth a look.
    const serious = direct.filter((v) => /critical|high/i.test(v.severity ?? ""));
    add({
      id: "deps.direct",
      section: "dependencies",
      level: serious.length ? "note" : direct.length ? "note" : "neutral",
      status: direct.length ? "concern" : "info",
      priority: serious.length ? "important" : direct.length ? "improvement" : undefined,
      kind: "detected",
      title: direct.length ? `${plural(direct.length, "flawed package")} used directly` : "Flawed packages are indirect",
      text: `Of the ${plural(vuln.length, "package")} with known flaws, ${direct.length ? `${direct.length} ${direct.length === 1 ? "is" : "are"} listed in its own manifests (${list(direct.map((v) => v.name))})` : "none are listed in its own manifests"}${dev.length ? `, ${dev.length} ${dev.length === 1 ? "is a development tool" : "are development tools"} (not shipped to users, but run in builds and CI)` : ""}, and ${vuln.length - direct.length - dev.length} ${vuln.length - direct.length - dev.length === 1 ? "comes" : "come"} in through other packages. A flaw only matters if the affected code is used; outdated isn't the same as vulnerable.`,
      evidence: direct.slice(0, 3).map((v) => { const d = deps.get(v.name.toLowerCase())!; return ev(d.file, d.line); }),
      action: direct.length ? "Update the direct ones first; indirect ones usually get fixed when their parent package updates." : undefined,
    });
  }

  // 9. Secrets.
  if (!f.whole) add({ id: "secrets.scan", section: "secrets", level: "neutral", status: "not-checked", kind: "detected", title: "Secrets not checked", text: "The repo was too large to read in full, so it wasn't scanned for exposed keys." });
  else {
    const hits = secrets(f);
    const real = hits.filter((h) => !h.test && !h.public);
    const publicKeys = hits.filter((h) => h.public && !h.test);
    const envFiles = f.paths.filter((p) => /(^|\/)\.env(\.(local|production|prod|development|dev|staging))?$/.test(p) && !NOT_APP_CODE.test(p));
    if (real.length)
      add({
        id: "secrets.found",
        section: "secrets",
        headline: "trust",
        level: "risk",
        priority: "important",
        kind: "detected",
        title: `${plural(real.length, "possible secret")} in the code`,
        text: `Found what look like real keys: ${list(real.map((h) => `${h.what} in ${h.path}:${h.line} (${h.shown})`), 4)}. They may be revoked already; if not, anyone can use them.`,
        evidence: real.slice(0, 4).map((h) => ev(h.path, h.line)),
        action: "Don't reuse these keys; when you run it, use your own. If they look real, tell the maintainers privately so they can revoke them.",
      });
    else
      add({ id: "secrets.found", section: "secrets", level: "good", kind: "detected", title: "No exposed keys found", text: `No known key formats (AWS, GitHub, Stripe, OpenAI, private keys and others) found in the ${plural(Object.keys(f.files).length, "file")} read${hits.length - publicKeys.length ? `, apart from ${plural(hits.length - publicKeys.length, "likely dummy key")} in test files` : ""}${publicKeys.length ? `${hits.length - publicKeys.length ? " and" : ", apart from"} ${plural(publicKeys.length, "browser key")} meant to be public (${list([...new Set(publicKeys.map((h) => h.path))], 2)})` : ""}. This catches known formats only.`, evidence: publicKeys.slice(0, 2).map((h) => ev(h.path, h.line)) });
    // Default passwords and secrets shipped to be changed (a template's "changethis"): fine to start with, a real
    // risk if deployed as they are.
    const PLACE = /^\s*-?\s*([A-Z][A-Z0-9_]*(SECRET|PASSWORD|PASS|KEY|TOKEN)[A-Z0-9_]*)\s*[=:]\s*['"]?(changethis|change[-_]?me|REPLACE[_-]WITH[\w-]*|your[-_]?(secret|password|key)[\w-]*|STRONG[_-]?[A-Z_]*PASSWORD|secret|password|admin|123456)['"]?\s*$/gim;
    const placeholders = Object.entries(f.files)
      .filter(([p]) => (/(^|\/)\.env$/.test(p) || COMPOSE.test(p)) && !NOT_APP_CODE.test(p))
      .flatMap(([p, t]) => [...t.matchAll(PLACE)].map((m) => ({ name: m[1], path: p, line: lines(t, m.index!) })));
    if (placeholders.length && (kind.kind === "app" || kind.kind === "template"))
      add({
        id: "secrets.placeholders",
        section: "secrets",
        level: "note",
        priority: "important",
        kind: "detected",
        title: "Default passwords to change before deploying",
        text: `${list([...new Set(placeholders.map((x) => x.name))], 5)} ${placeholders.length === 1 ? "is" : "are"} set to placeholder values in ${list([...new Set(placeholders.map((x) => x.path))], 2)}. That's fine for trying it locally; anyone who knows the defaults can get in if it's deployed that way.`,
        evidence: placeholders.slice(0, 3).map((x) => ev(x.path, x.line)),
        action: "Generate your own values for these before exposing it to a network.",
      });
    if (envFiles.length)
      add({ id: "secrets.envfile", section: "secrets", level: "note", priority: "improvement", kind: "detected", title: "A settings file is committed", text: `${list(envFiles)} ${envFiles.length === 1 ? "is" : "are"} in the repo. These usually hold private settings; check ${envFiles.length === 1 ? "it doesn't" : "they don't"} contain real values before using ${envFiles.length === 1 ? "it" : "them"}.`, evidence: envFiles.slice(0, 2).map((p) => ev(p)) });
  }

  // 10. Tests and CI: tests existing isn't tests passing.
  if (applies("tests")) {
    // Rust keeps unit tests inside the source files (#[cfg(test)]): those count too.
    const inline = Object.entries(f.files).filter(([p, t]) => /\.rs$/.test(p) && /#\[cfg\(test\)\]/.test(t)).map(([p]) => p);
    const tests = [...new Set([...f.paths.filter((p) => TEST_FILE.test(p) && !/(^|\/)(node_modules|vendor|\.[^/]+)\//.test(p)), ...inline])];
    const testDirs = new Map<string, number>();
    for (const t of tests) {
      const d = /^(.*?(?:^|\/)(?:tests?|__tests__|specs?|e2e))\//.exec(t)?.[1] ?? dirOf(t);
      testDirs.set(d, (testDirs.get(d) ?? 0) + 1);
    }
    const mainTests = [...testDirs.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const pkg = json(f.files["package.json"]);
    const testScript = pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test) ? `npm test (${pkg.scripts.test.slice(0, 60)})` : null;
    const runner = testScript ?? (/\[tool\.pytest|pytest/.test((f.files["pyproject.toml"] ?? "") + (f.files["setup.cfg"] ?? "") + (f.files["tox.ini"] ?? "")) || f.paths.includes("pytest.ini") ? "pytest" : f.files["go.mod"] ? "go test" : f.files["Cargo.toml"] ? "cargo test" : Object.entries(f.files).some(([p, t]) => MAKEFILE.test(p) && /^test:/m.test(t)) ? "make test" : null);
    const workflows = Object.entries(f.files).filter(([p]) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
    const TESTS_IN_CI = /\b(make ci|-m pytest|hatch (run|test)|nox -s|uv run pytest|poetry run pytest|npm (run )?test|pnpm (run )?test|yarn test|bun test|pytest|tox|nox|go test|cargo (test|nextest)|make (test|check)|vitest|jest|mocha|rspec|phpunit|mvn (test|verify|-B)|gradle\w* (test|check|build)|dotnet test|mix test|swift test|flutter test|ctest|npm run (ci|check))\b/;
    const ciTests = workflows.filter(([, t]) => TESTS_IN_CI.test(t) || /uses:\s*\.\/\.github\/workflows\//.test(t));
    const ciNamedTests = (facts.ci?.runs ?? []).some((r) => /\b(tests?|unit|e2e|spec|integration)\b/i.test(r.name)) || workflows.some(([p, t]) => /test/i.test(p) && /\brun:/.test(t));
    if (tests.length)
      add({ id: "tests.present", section: "tests", level: "good", kind: "detected", title: `${plural(tests.length, "test file")}`, text: `It has ${plural(tests.length, "test file")}${runner ? `, run with ${runner}` : ""}. That they exist doesn't mean they pass: see the CI result.`, evidence: mainTests ? [{ ...ev(mainTests), url: `${link(mainTests).replace("/blob/", "/tree/")}` }] : undefined });
    else
      add({ id: "tests.present", section: "tests", level: facts.repo.stars >= 300 ? "note" : "neutral", status: "not-found", priority: "improvement", kind: "detected", title: "No tests found", text: "Not found in the files read: test files or a test command. Changes can't be checked automatically." });
    if (tests.length && !ciTests.length && !ciNamedTests && f.whole)
      add({ id: "tests.ci", section: "tests", level: "note", status: workflows.length ? "concern" : "not-found", priority: "improvement", kind: "detected", title: workflows.length ? "CI doesn't run the tests" : "No CI", text: workflows.length ? `None of its ${plural(workflows.length, "GitHub Actions workflow")} appear to run the tests.` : "Not found in the files read: GitHub Actions workflows (it may use another CI service)." });
    const ci = facts.ci;
    if (ci) ci.runs = ci.runs.filter((r, i, all) => all.findIndex((x) => x.name === r.name) === i);
    if (ci && ci.runs.length) {
      const failed = ci.runs.filter((r) => r.conclusion === "failure" || r.conclusion === "timed_out");
      const passed = ci.runs.filter((r) => r.conclusion === "success");
      const where = ci.source === "commit" ? "the inspected commit" : `the latest runs on ${facts.repo.defaultBranch}`;
      add({
        id: "tests.result",
        section: "tests",
        level: failed.length ? (failed.length >= passed.length ? "risk" : "note") : passed.length ? "good" : "neutral",
        priority: failed.length ? "important" : undefined,
        kind: "reported",
        title: failed.length ? `${failed.length} of ${ci.runs.length} checks failing` : passed.length ? "CI passing" : "CI results unclear",
        text: failed.length
          ? `GitHub reports ${failed.length} of ${plural(ci.runs.length, "check")} failing on ${where}: ${list(failed.map((r) => r.name))}. The code at this point may not build or pass its tests.`
          : passed.length
            ? `GitHub reports ${passed.length} of ${plural(ci.runs.length, "check")} passing on ${where}${passed.length < ci.runs.length ? "; the rest were skipped or cancelled" : ""}.`
            : `GitHub has ${plural(ci.runs.length, "check")} for ${where}, none finished as passed or failed.`,
        evidence: (failed.length ? failed : passed).slice(0, 3).map((r) => ({ label: r.name, url: r.url })),
        action: failed.length ? "Check whether a recent release passed, and install that version instead of the latest code." : undefined,
      });
    } else if (ci)
      add({ id: "tests.result", section: "tests", level: "neutral", status: "not-found", kind: "reported", title: "No CI results", text: `GitHub shows no finished build or test runs for the inspected commit or recent runs on ${facts.repo.defaultBranch}. Its CI may run only on pull requests, or on another service.` });
  }

  // 11. Deployment (apps only).
  if (applies("deploy")) {
    const dockerfile = f.paths.filter((p) => DOCKERFILE.test(p) && !NOT_APP_CODE.test(p)).sort(byDepth)[0];
    const composeFile = f.paths.filter((p) => COMPOSE.test(p) && !NOT_APP_CODE.test(p)).sort(byDepth)[0];
    const health =
      Object.entries(f.files).find(([p, t]) => (DOCKERFILE.test(p) && /^HEALTHCHECK\s/m.test(t)) || (COMPOSE.test(p) && /^\s+healthcheck:/m.test(t))) ??
      Object.entries(f.files).find(([p, t]) => CODE.test(p) && !NOT_APP_CODE.test(p) && !/client/i.test(p) && (/['"`]\/(api\/)?(health|healthz|healthcheck|livez|readyz|ready|ping)['"`]/.test(t) || /\bHeartbeat\(/.test(t))) ??
      (f.paths.find((p) => /(^|\/)(api\/)?(health|healthz|healthcheck)(\/route)?\.[jt]sx?$/.test(p)) ? ([f.paths.find((p) => /(^|\/)(api\/)?(health|healthz|healthcheck)(\/route)?\.[jt]sx?$/.test(p))!, ""] as [string, string]) : undefined);
    const DEPLOY = /\b(deploy(ing)? (it|to|on|with|in)|deployment (guide|docs|instructions)|in production|production (setup|deployment|environment|use|build)|self[- ]host(ing|ed)?|kubernetes|helm chart|reverse proxy)\b/i;
    // A guide counts: a deployment doc, or a deployment heading in the docs. A word in passing ("self-host") is only a lead.
    const HEADING = /^#{1,4}\s+.*\b(deploy(ing|ment)?|production|self[- ]?host(ing|ed)?|hosting|kubernetes|running in production)\b.*$/im;
    const guideFile = Object.keys(f.files).find((p) => DOC.test(p) && !/(^|\/)\.[^/]+\//.test(p) && /(^|\/)[^/]*(deploy|self-?host|production|hosting)[^/]*$/i.test(p));
    const headingIn = docs.find((d) => HEADING.test(f.files[d]));
    const deployIn = guideFile ?? headingIn ?? docs.find((d) => DEPLOY.test(f.files[d]));
    const deployDoc = guideFile ? [guideFile.split("/").pop()!] : headingIn ? [HEADING.exec(f.files[headingIn])![0].replace(/^#+\s+/, "").trim()] : deployIn ? DEPLOY.exec(f.files[deployIn]) : null;
    const deployGuide = Boolean(guideFile || headingIn);
    const BACKUP = /\bback(ing)? ?up (your|the) (data|database)|\bbackups?\b|pg_dump|mysqldump|mongodump/i;
    const backupIn = Object.keys(f.files).find((p) => DOC.test(p) && !/(^|\/)\.[^/]+\//.test(p) && BACKUP.test(f.files[p]));
    const dbs = Object.keys(f.files).filter((p) => COMPOSE.test(p) && !NOT_APP_CODE.test(p)).flatMap((p) => composeServices(f.files[p]).map((s) => ({ ...s, file: p }))).filter((s) => SERVICES.some((x) => (x.sql || x.name === "MongoDB") && ((s.image && x.image.test(s.image)) || x.image.test(s.name))));
    // Helper containers (a readiness check, a migration runner, a test database) don't keep data.
    // A production overlay (docker-compose.prod.yml) often adds the volume the base file leaves out (Coolify).
    const volumed = new Set(Object.keys(f.files).filter((p) => COMPOSE.test(p)).flatMap((p) => composeServices(f.files[p]).filter((x) => /^\s+volumes:/m.test(x.body)).map((x) => x.name)));
    const noVolume = dbs.filter((s) => !/^\s+volumes:/m.test(s.body) && !volumed.has(s.name) && !/ready|wait|init|migrat|test|seed|setup|check/i.test(s.name) && !/(^|\/)(dev|test|ci|e2e)[\w.-]*\.ya?ml$|compose\.(dev|test|ci|e2e)[\w.-]*\.ya?ml$/i.test(s.file));
    const usesDb = dbs.length > 0 || SERVICES.some((s) => s.sql && s.deps.some((d) => deps.get(d.toLowerCase()) && !deps.get(d.toLowerCase())!.dev)) || Boolean(Object.keys(f.files).find((p) => /schema\.prisma$/.test(p)));
    const backup = Boolean(backupIn);
    add({ id: "deploy.container", section: "deploy", level: dockerfile || composeFile ? "good" : "neutral", status: dockerfile || composeFile ? "pass" : "not-found", kind: "detected", title: dockerfile ? "Has a Dockerfile" : composeFile ? "Has a Compose file" : "No container setup", text: dockerfile || composeFile ? `Container setup found (${list([dockerfile, composeFile].filter(Boolean) as string[])}). Building and starting it weren't checked.` : "Not found in the files read: a Dockerfile or Compose file.", evidence: [dockerfile, composeFile].filter(Boolean).map((p) => ev(p!)) });
    add({ id: "deploy.health", section: "deploy", level: health ? "good" : "note", status: health ? "pass" : "not-found", priority: health ? undefined : "improvement", kind: "detected", title: health ? "Health check" : "No health check found", text: health ? `It has a health check (${health[0]}), so a host can tell when it's up.` : "No explicit health check (a Docker HEALTHCHECK or a /health route) found in the files read. Without one, a host or monitor has to rely on its own checks to tell if it's stuck.", evidence: health ? [ev(health[0])] : undefined });
    if (noVolume.length)
      add({ id: "deploy.volumes", section: "deploy", level: "risk", priority: "important", kind: "detected", title: "Database data isn't kept", text: `${noVolume[0].file} runs ${list(noVolume.map((s) => s.name))} without a volume, so ${noVolume.length === 1 ? "its" : "their"} data is lost when the container is removed.`, evidence: noVolume.slice(0, 2).map((s) => ev(s.file, s.line)), action: "Add a named volume for the database's data folder before keeping real data in it." });
    add({
      id: "deploy.docs", section: "deploy",
      level: deployGuide ? "good" : deployDoc ? "neutral" : "note",
      status: deployGuide ? "pass" : deployDoc ? "info" : "not-found",
      priority: deployGuide || deployDoc ? undefined : "improvement",
      kind: deployDoc ? "documented" : "detected",
      title: deployGuide ? "Deployment guide found" : deployDoc ? "Deployment mentioned, no guide" : "No deployment guide",
      text: guideFile ? `It has a deployment guide (${guideFile}). Whether its steps work wasn't checked.` : headingIn ? `${headingIn} has a section on running it for real ("${deployDoc![0]}"). Whether its steps work wasn't checked.` : deployDoc ? `${deployIn} mentions "${deployDoc[0]}", but no deployment guide or section was found in the files read.` : "Not found in the files read: instructions for running it in production.", evidence: deployIn ? [ev(deployIn, deployDoc && f.files[deployIn].indexOf(deployDoc[0]) >= 0 ? lines(f.files[deployIn], f.files[deployIn].indexOf(deployDoc[0])) : undefined)] : undefined });
    if (usesDb)
      add({ id: "deploy.backup", section: "deploy", level: backup ? "good" : "note", status: backup ? "pass" : "not-found", priority: backup ? undefined : "improvement", kind: backup ? "documented" : "detected", title: backup ? "Backups mentioned" : "No backup guidance", text: backup ? `The docs mention backing up its data (${backupIn}).` : "It stores data in a database, but no guidance on backing it up was found in the files read.", evidence: backupIn ? [ev(backupIn)] : undefined });
  }

  return { findings: out, kind, steps: setupSteps(cmds, missing, out, repoName) };
}

// ── The setup path: the documented steps, one per phase ───────────────────────────────────────────────────────────
const PHASES: [StepPhase, (a: string[], raw: string) => boolean][] = [
  ["get", (a) => (a[0] === "git" && a[1] === "clone") || (a[0] === "gh" && a[1] === "repo" && a[2] === "clone") || (/^(curl|wget)$/.test(a[0]) && a.some((x) => /^-(o|O|L?o)$|^--output/.test(x))) || (a[0] === "docker" && a[1] === "pull")],
  ["configure", (a, raw) => (/^(cp|copy|mv)$/.test(a[0]) && /\.env|example|sample|config/i.test(raw)) || /^(openssl|export)$/.test(a[0])],
  ["services", (a, raw) => ((a[0] === "docker" && a[1] === "compose") || a[0] === "docker-compose") && /\b(up|start)\b/.test(raw) && /\b(db|postgres|redis|mysql|mongo|database|services?)\b/i.test(raw)],
  ["database", (_, raw) => /prisma\s+(migrate|db\s+push)|alembic\s+upgrade|manage\.py\s+migrate|rails\s+db:|rake\s+db:|artisan\s+migrate|drizzle-kit\s+(push|migrate)|knex\s+migrate|\bdb:(migrate|push|setup|prepare)\b|\bmigrate\b/i.test(raw)],
  ["install", (a) => (/^(npm|pnpm|yarn|bun)$/.test(a[0]) && (a.length === 1 || (/^(install|i|ci)$/.test(a[1] ?? "") && a.length <= 3) || (a[1] === "run" && /^(setup|bootstrap|install)$/.test(a[2] ?? "")))) || (a[0] === "make" && /^(install|setup|deps|bootstrap)$/.test(a[1] ?? "")) || /^\.\/(install|setup|bootstrap)[\w.-]*$/.test(a[0]) || (/^(pip3?|uv|poetry|pipx|bundle|composer|go|cargo|brew|apt(-get)?|pacman|dnf|winget|scoop|choco|flatpak|snap)$/.test(a[0]) && /^(install|sync|add|get|i)$/.test(a[1] ?? ""))],
  ["build", (a, raw) => /^(make|cmake|ninja|meson|gradle|\.\/gradlew|mvn|cargo|go|npm|pnpm|yarn|bun|docker)$/.test(a[0]) && /\bbuild\b/.test(raw)],
  // Starting it, per tool: a script, a module, a server command, compose up, a make target, a binary.
  ["run", (a) => {
    const [cmd, sub = "", third = ""] = a;
    if (/^(npm|pnpm|yarn|bun)$/.test(cmd)) return /^(start|dev|serve|preview)$/.test(sub) || (sub === "run" && /^(start|dev|serve|preview)$/.test(third));
    if (/^python3?$/.test(cmd)) return /\.py$/.test(sub) || sub === "-m" || /runserver/.test(a.join(" "));
    if (/^(node|deno|bun|tsx)$/.test(cmd)) return /\.[cm]?[jt]s$/.test(sub) || sub === "run";
    if (/^(go|cargo|flask|dotnet|rails|php|java|streamlit)$/.test(cmd)) return /^(run|serve|server|s|-jar|artisan)$/.test(sub);
    if (/^(uvicorn|gunicorn|pm2)$/.test(cmd)) return true;
    if (cmd === "docker") return sub === "run" || (sub === "compose" && a.includes("up"));
    if (cmd === "docker-compose") return a.includes("up");
    if (cmd === "make") return /^(run|start|dev|serve|up)$/.test(sub);
    return /^\.\/[\w.-]+$/.test(cmd) && !/install|setup|build|test/i.test(cmd);
  }],
];
const PHASE_CHECKS: Record<StepPhase, string[]> = {
  get: [],
  install: ["setup.manager", "setup.versions"],
  configure: ["config.env", "config.example", "secrets.placeholders"],
  services: ["services.missing", "services.compose", "services.accounts"],
  database: ["setup.migrations"],
  build: [],
  run: [],
};
const MISS_ID: Record<string, string> = { script: "setup.scripts", target: "setup.make", file: "setup.files", manifest: "setup.files", lock: "setup.files" };
const ROUTE = /install|getting started|get started|quick ?start|setup|set up|self-?host|docker|running|run it|usage|deploy/i;
function setupSteps(cmds: Command[], missing: Missing[], found: Finding[], repoName = ""): SetupStep[] {
  const user = cmds.filter((c) => !c.inline && !c.contrib && !c.foreign);
  const own = (c: Command) => !(c.argv[0] === "docker" && /^(pull|run)$/.test(c.argv[1] ?? "")) || c.raw.toLowerCase().includes(repoName.toLowerCase());
  // One route: the commands of one section of the docs, in reading order, first one per phase. Sections titled
  // like an install guide come first; the first that makes a path (two steps or more) is the one shown.
  const sections = [...new Set(user.map((c) => c.section ?? c.doc))];
  sections.sort((a, b) => Number(!ROUTE.test(a.split("#")[1] ?? "")) - Number(!ROUTE.test(b.split("#")[1] ?? "")));
  let steps: SetupStep[] = [];
  for (const sec of sections) {
    const route: SetupStep[] = [];
    for (const c of user.filter((x) => (x.section ?? x.doc) === sec)) {
      const phase = PHASES.find(([, test]) => test(c.argv, c.raw))?.[0];
      if (!phase || !own(c) || route.some((s) => s.phase === phase)) continue;
      const atLine = missing.filter((m) => m.doc === c.doc && m.line === c.line).map((m) => MISS_ID[m.what]).filter((id) => found.some((x) => x.id === id));
      route.push({ phase, command: c.raw.slice(0, 120), doc: c.doc, line: c.line, findings: [...new Set(atLine)] });
    }
    if (route.length >= 2) {
      steps = route;
      break;
    }
  }
  if (!steps.length) return [];
  // The checks about each phase, and a database step even when the docs have none (that's the finding).
  for (const st of steps) st.findings = [...new Set([...st.findings, ...found.filter((x) => PHASE_CHECKS[st.phase].includes(x.id)).map((x) => x.id)])];
  const db = found.find((x) => x.id === "setup.migrations" && x.status === "concern");
  if (db && !steps.some((s) => s.phase === "database")) {
    const before = steps.findIndex((s) => s.phase === "build" || s.phase === "run");
    steps.splice(before < 0 ? steps.length : before, 0, { phase: "database", command: "", doc: "", line: 0, findings: [db.id] });
  }
  return steps.slice(0, 7);
}

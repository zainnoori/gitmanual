import { analyze, inFolder, mainSubfolder, presentPaths, selectFiles, type Analysis } from "./detect";
import { after } from "next/server";
import { CACHE_MS, countView, readSaved, repoKey, saveRepo } from "./db";
import { getFiles, getHeadSha, getLatestRelease, getRepoMeta, getTree, GitHubError, type RepoMeta, type RepoRef } from "./github";
import { findDocsLink, findDownloadPage, findSetupDocs, findSetupScripts, type Guides, type SetupDoc } from "./guides";
import { announceRepo } from "./indexnow";
import { parseRelease, readmeInstallCommands, type InstallOptions } from "./install";
import { OS_LIST } from "./os";
import { declaredPlatforms, mentions } from "./platforms";
import { platformFiles, platformOnly } from "./platform";

// Bump when the analysis output changes shape or rules, so saved copies are re-analyzed instead of shown.
export const VERSION = 14; // 14: build-only Dockerfiles, Android APK releases in the will-it-work answer

export type RepoData = {
  version: number;
  // commit: the branch's commit when it was read (missing on copies read before it was recorded), for the PDF's version stamp.
  meta: RepoMeta & { branch: string; fileCount: number; treeTruncated: boolean; commit?: string };
  analysis: Analysis;
  install: InstallOptions;
  guides: Guides;
  files: Record<string, string>;
};

export type Loaded = { key: string; data: RepoData; analyzedAt: number; cached: boolean; stale?: boolean };

// A view is counted after the page has been sent: it's a write to the database's primary (and to every index on
// views), and the visitor shouldn't wait for it. Outside a request (scripts, tests) it's counted right away.
function viewed(key: string) {
  try {
    after(() => countView(key));
  } catch {
    void countView(key);
  }
}

// A saved manual comes straight from the database: instant, and no GitHub calls. Once it's older than 12 hours it's
// still shown straight away, and read again from GitHub after the page is sent (not for crawlers: a crawler walking
// the shelf re-read hundreds of repos an hour while it waited, 2026-11-18). A saved copy from an older VERSION has
// a different shape, so that one is read again before the page is shown.
// gate runs only when the repo has to be read from GitHub (see lib/limit.ts); it throws to refuse.
export async function loadRepo(
  ref: RepoRef,
  opts: { fresh?: boolean; view?: boolean; bot?: boolean; gate?: () => Promise<void> } = {},
): Promise<Loaded> {
  const lookup = repoKey(ref.owner, ref.repo, ref.ref);
  const saved = await readSaved(lookup);
  const cached = saved && saved !== "error" && (saved.data as RepoData).version === VERSION ? saved : null;
  if (cached && !opts.fresh) {
    if (!opts.bot && Date.now() - cached.analyzedAt >= CACHE_MS) refreshLater(ref, lookup, opts.gate);
    if (opts.view) viewed(lookup);
    return { key: lookup, data: cached.data as RepoData, analyzedAt: cached.analyzedAt, cached: true };
  }

  try {
    await opts.gate?.();
    // The database didn't answer: the page is built from GitHub, but not saved or counted, so a struggling
    // database doesn't get a big write on top.
    if (saved === "error") return { key: lookup, data: await readPublic(ref), analyzedAt: Date.now(), cached: false };
    const loaded = await rebuild(ref, !saved);
    if (opts.view) viewed(loaded.key);
    return loaded;
  } catch (err) {
    // GitHub is down or rate-limited, or the visitor is over a limit: an older saved copy beats an error page.
    if (!cached) throw err;
    if (opts.view) viewed(lookup);
    return { key: lookup, data: cached.data as RepoData, analyzedAt: cached.analyzedAt, cached: true, stale: true };
  }
}

async function readPublic(ref: RepoRef): Promise<RepoData> {
  const data = await analyzeRepo(ref);
  // The site's own token may be able to see private repos (its owner's); those never go on the public shelf.
  if (data.meta.private) throw new GitHubError("Repository not found (or it is private).", 404);
  return data;
}

// Reads the repo from GitHub and saves it. isNew: it wasn't on the shelf before.
async function rebuild(ref: RepoRef, isNew: boolean): Promise<Loaded> {
  const data = await readPublic(ref);
  const [owner, name] = data.meta.fullName.split("/");
  const key = repoKey(owner, name, ref.ref);
  const { meta, analysis } = data;
  const analyzedAt = await saveRepo(
    key,
    { fullName: meta.fullName, description: meta.description, stars: meta.stars, language: meta.language, difficulty: analysis.difficulty.label },
    data,
  );
  // A repo new to gitmanual (main branch only; branch views aren't indexed): tell search engines about its pages.
  if (isNew && !ref.ref) announceRepo(meta.fullName);
  return { key, data, analyzedAt, cached: false };
}

// Background re-reads of expired manuals: each repo once at a time, and a few at once per server, so a burst of
// visits to old manuals doesn't turn into a burst of GitHub reads and big writes. One that's skipped is re-read on a
// later visit.
const refreshing = new Set<string>();
const MAX_REFRESHING = 3;

function refreshLater(ref: RepoRef, key: string, gate?: () => Promise<void>) {
  if (refreshing.has(key) || refreshing.size >= MAX_REFRESHING) return;
  refreshing.add(key);
  const run = () =>
    (async () => {
      await gate?.();
      await rebuild(ref, false);
    })()
      .catch(() => {}) // the saved copy stays; the next visit tries again
      .finally(() => refreshing.delete(key));
  try {
    after(run);
  } catch {
    void run();
  }
}

// A private repo, read with the visitor's own GitHub access: built in memory for them and never saved, counted or
// listed anywhere (no database, no shelf, no sitemap).
export async function loadPrivate(ref: RepoRef, token: string): Promise<{ data: RepoData; analyzedAt: number }> {
  const data = await analyzeRepo(ref, token);
  return { data: { ...data, meta: { ...data.meta, private: true } }, analyzedAt: Date.now() };
}

async function analyzeRepo(ref: RepoRef, token?: string): Promise<RepoData> {
  const meta = await getRepoMeta(ref, token);
  const branch = ref.ref ?? meta.defaultBranch;
  const [{ entries, truncated }, rawRelease, commit] = await Promise.all([
    getTree(ref, branch, token),
    getLatestRelease(ref, token),
    // A private repo is read with the visitor's token; this lookup uses the site's, so it's skipped (and best effort).
    token ? undefined : getHeadSha(ref, branch).catch(() => undefined),
  ]);
  const docs = findSetupDocs(entries);
  const docEntry = docs[0] && entries.find((e) => e.path === docs[0].path);
  const rootFiles = await getFiles(ref, branch, [...selectFiles(entries), ...(docEntry ? [docEntry] : [])], token);
  // A project kept whole in one folder (src/Cargo.toml and nothing at the root): its files are read as the root's,
  // and the steps start in that folder. The root's README and workflows stay.
  const workdir = mainSubfolder(entries);
  const sub = workdir ? inFolder(entries, workdir) : [];
  const subPicked = selectFiles(sub).filter((e) => !/^readme(\.\w+)?$/i.test(e.path) && !(e.path in rootFiles));
  const subFiles = subPicked.length
    ? await getFiles(ref, branch, subPicked.map((e) => ({ ...e, path: `${workdir}/${e.path}` })), token)
    : {};
  const files = { ...rootFiles, ...subFiles }; // real paths, as listed under "Files we read"
  const asRoot = { ...rootFiles, ...Object.fromEntries(Object.entries(subFiles).map(([p, t]) => [p.slice(workdir!.length + 1), t])) };
  // Project files that say which system the code is written for: read only for that check, not kept with the manual.
  const platformExtra = await getFiles(ref, branch, platformFiles(entries).filter((e) => !(e.path in files)), token).catch(() => ({}) as Record<string, string>);
  const [owner, name] = meta.fullName.split("/");
  const treePaths = entries.map((e) => e.path);
  const analysis = workdir
    ? analyze(
        { owner, repo: name },
        asRoot,
        new Set([...presentPaths(entries), ...presentPaths(sub)]),
        [...treePaths.filter((p) => !p.includes("/")), ...sub.map((e) => e.path)],
        meta.language,
        meta.description,
        { workdir, treePaths },
      )
    : analyze({ owner, repo: name }, files, presentPaths(entries), treePaths, meta.language, meta.description);

  const readme = Object.entries(files).find(([p]) => /^readme(\.\w+)?$/i.test(p))?.[1];
  const release = parseRelease(rawRelease);
  const text = `${meta.description ?? ""}\n${readme ?? ""}`;
  const declared = declaredPlatforms(meta.description, readme);
  // A ready-made download for a system beats a sentence saying it's unsupported (the README may be out of date).
  if (declared) declared.unsupported = declared.unsupported.filter((os) => !release?.assets.some((a) => a.os === os));
  const commands = readmeInstallCommands(readme, { owner, name })
    .filter((c) => !/compose/.test(c.command) || composeRunsApp(files, readme, name))
    .map((c) => ({
      ...c,
      // Homebrew, Nix and install scripts also run on Linux, but only count there when the project mentions Linux.
      os: c.os.filter(
        (os) =>
          !declared?.unsupported.includes(os) &&
          (os !== "linux" || !/^(Homebrew|Nix|install script)$/.test(c.method) || mentions(text, "linux") || Boolean(release?.assets.some((a) => a.os === "linux"))),
      ),
    }))
    .filter((c) => c.os.length);
  const downloadPage = findDownloadPage(readme, { name, website: meta.homepage });
  const install: InstallOptions = {
    release,
    commands,
    declared: declared?.unsupported.length ? declared : null,
    platforms: OS_LIST.filter(
      (os) =>
        release?.assets.some((a) => a.os === os) || commands.some((c) => c.kind === "app" && c.os.includes(os)) || downloadPage?.platforms.includes(os),
    ),
    downloadPage,
  };
  // Made for one system: unless the README already says which ones aren't supported.
  if (!install.declared)
    install.only = platformOnly({
      description: meta.description,
      readme,
      paths: entries.map((e) => e.path),
      files: { ...platformExtra, ...Object.fromEntries(Object.entries(files).filter(([p]) => /^\.github\/workflows\/|(^|\/)(Cargo\.toml|Package\.swift|meson\.build|CMakeLists\.txt|configure\.ac)$|\.(cs|vb|fs)proj$/.test(p))) },
      release,
      language: meta.language,
    });
  const docsLink = findDocsLink(readme, { name, website: meta.homepage });
  const guides: Guides = {
    website: meta.homepage,
    docs: docsLink && docsLink !== meta.homepage ? docsLink : null,
    doc: usableDoc(docs[0], files),
    otherDocs: docs.slice(1),
    scripts: findSetupScripts(entries),
    devcontainer: entries.some((e) => e.path === ".devcontainer/devcontainer.json" || e.path === ".devcontainer.json"),
  };

  return { version: VERSION, meta: { ...meta, branch, fileCount: entries.length, treeTruncated: truncated, ...(commit && { commit }) }, analysis, install, guides, files };
}

// A CONTRIBUTING file only counts as a setup guide when it actually has a setup section.
function usableDoc(doc: SetupDoc | undefined, files: Record<string, string>): Guides["doc"] {
  const text = doc && files[doc.path];
  if (!doc || !text) return null;
  if (doc.label === "Contributing guide") {
    if (!/^#{1,4}\s.*\b(set ?up|install|getting started|prerequisites|development environment|build(ing)?|local development)\b/im.test(text)) return null;
    return { ...doc, label: "Development setup", markdown: text.slice(0, 20000) };
  }
  return { ...doc, markdown: text.slice(0, 20000) };
}

// "docker compose up" starts the app itself only if a compose file builds or pulls this project, not just its databases.
function composeRunsApp(files: Record<string, string>, readme: string | undefined, name: string): boolean {
  const own = (text: string | undefined) =>
    Boolean(text) && (/^\s*build:/m.test(text!) || new RegExp(`^\\s*image:.*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "im").test(text!));
  const compose = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].map((p) => files[p]).find(Boolean);
  return own(compose) || own(readme);
}

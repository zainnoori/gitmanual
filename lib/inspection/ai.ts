import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Usage } from "../budget";
import type { Facts } from "./collect";
import type { Architecture, Decision, Finding, HeadlineId, ProjectKind } from "./types";

// Claude reads what rules can't: the license's real terms, telemetry described in prose, setup steps that don't add
// up, and how the parts fit together. It adds findings only with quotes copied from the repo's files, and each quote
// is checked against those files before it's kept, so nothing it says can be made up. Architecture paths are checked
// to exist. It also writes the decision summary at the top, from the findings it's given.

export const MODEL = "claude-haiku-5-5" as const; // the cheap tier: quotes are checked in code, so a smaller model is enough
export const MAX_OUTPUT = 6000;
export const MAX_PROMPT_TOKENS = 35_000;

const SYSTEM = `You help people decide whether to use an open source repository and what they'll need to run it. You get the findings that rules already produced from the repository's files (each with an id, status and priority), the file list, and excerpts of key files.

Do four things:
1. A decision summary, using only the findings and files given:
   - does: one or two sentences on what it does and who it's for, and whether it's an app, library, command-line tool, template or demo.
   - needs: what someone needs to run it (runtimes, services, accounts, hardware), short items. Mark optional things as optional.
   - blockers: the main setup blockers and open questions, most serious first. Only what would stop someone or needs a decision; a Dockerfile using a newer version than the docs' minimum is normal, not a conflict. Don't repeat a rule finding you dispute. Empty if none.
   - first: what to check or fix first, as concrete steps.
   - business: one or two sentences for a business deciding whether to adopt it (license duties, maintenance, risk).
   Plain words, no hype, never call it "safe" or "unsafe". Say "not found in the files read" rather than "doesn't have". Nothing was installed, built or run: say a step "would fail", never that it fails. When only some files were read (see <coverage>), make no claim about the rest of the repo. In "first", when it isn't clear a step is needed or how a fix should be run, the step is to check that first.
   Write for the reader about the repository. Never mention excerpts, rules, checks, findings, prompts or "an earlier check".
2. Architecture (always fill it in; for a library or a list of links, leave parts and links empty): a one-sentence summary and up to 8 main parts (frontend, backend, database, queue, storage, workers, CLI, external services...) with their role and 1-3 real paths from the file list, plus the links between them ("from" and "to" are part names exactly as you wrote them, "label" is 1-3 words such as "REST API", "SQL", "jobs"; only links the files show). Skip it for a library or a list of links.
3. Up to 5 findings the rules missed. Topics: setup (docs that contradict the files, undocumented prerequisites, a default that needs a paid account), use (the maintainers' own advice on intended use, such as "not for production" or "demo only"; a recommendation, not a license term), security (an insecure default, code that runs with broad access, trust assumptions), open/obligations/free (only what license texts in the files say: terms, paid tiers, relicensing), data (telemetry, phoning home), cost (required paid services, hardware). Not findings: contribution policies (whether pull requests are accepted), standard disclaimers ("the dev server isn't for production"), and plain facts about how it's set up.
   Priority: "important" only when it changes whether someone can run it, use it legally, or keep their data and systems safe; otherwise "improvement". Never "blocker".
   Each needs 1 or 2 "quotes": text copied exactly from the files, 4 to 30 words each, that together prove it on their own (a quote that only names the project proves nothing) (for a contradiction, quote both sides). Titles under 60 characters, stating the issue. An action is a supported next step or says what to check; don't invent settings, flags or commands the files don't show. Skip anything the findings already cover. If nothing solid, return none.
4. Disputes: rule findings (by id) that the files show are wrong or overstated, such as a "missing" step the code does automatically at startup, or a file the docs tell you to create. Each needs a short reason and 1 or 2 exact quotes that show it. Only when the quotes settle it; otherwise none.`;

// No length limits in the schema: an answer with one item too many would be thrown away whole. Lists are trimmed below.
const Out = z.object({
  does: z.string(),
  needs: z.array(z.string()),
  blockers: z.array(z.string()),
  first: z.array(z.string()),
  business: z.string(),
  architecture: z
    .object({
      summary: z.string(),
      parts: z.array(z.object({ name: z.string(), role: z.string(), paths: z.array(z.string()) })),
      links: z.array(z.object({ from: z.string(), to: z.string(), label: z.string() })),
    }), // always an object: given the choice, the small model leaves it null (parts are empty for a library)
  findings: z
    .array(
      z.object({
        headline: z.enum(["setup", "use", "security", "open", "obligations", "free", "data", "cost"]),
        level: z.enum(["good", "note", "risk"]),
        priority: z.enum(["blocker", "important", "improvement"]),
        title: z.string(),
        text: z.string(),
        action: z.string(),
        quotes: z.array(z.object({ file: z.string(), text: z.string() })).min(1),
      }),
    )
    ,
  disputes: z.array(z.object({ id: z.string(), reason: z.string(), quotes: z.array(z.object({ file: z.string(), text: z.string() })).min(1) })),
});

const SECTION: Record<string, Finding["section"]> = { setup: "setup", use: "setup", security: "security", open: "license", obligations: "license", free: "license", data: "privacy", cost: "cost" };
// The most each topic can matter: advice on intended use and costs are worth knowing, never a reason to stop.
const CAP: Record<string, Finding["priority"]> = { setup: "important", use: "improvement", security: "important", open: "important", obligations: "important", free: "improvement", data: "important", cost: "improvement" };
const squash = (s: string) => s.replace(/[\s*_`>#-]+/g, " ").trim().toLowerCase();

// The files Claude sees, trimmed: license, README and setup docs longest, then the files that say how it runs.
const LIMIT: [RegExp, number][] = [
  [/^(LICEN[CS]E|COPYING)/i, 6000],
  [/^README/i, 12000],
  [/^((docs?|\.github)\/)?(INSTALL|SETUP|GETTING|QUICKSTART|DEVELOP|SELF|DEPLOY)/i, 4000],
  [/^docs?\/.*(install|setup|getting-started|quickstart|self-host|deploy|configur)/i, 3000],
  [/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/i, 3000],
  [/^(Dockerfile|Containerfile)$/, 2000],
  [/^(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Gemfile|composer\.json|requirements\.txt)$/, 3000],
  [/(CONTRIBUTING|PRIVACY|TELEMETRY|SECURITY|CLA|GOVERNANCE|telemetry|privacy)/i, 2500],
  [/(^|\/)(\.env(\.[\w-]+)*\.(example|sample|template)|example\.env|env\.example)$/i, 2000],
  [/^Makefile$/, 2000],
];
export function excerpts(files: Record<string, string>): string {
  const picked: string[] = [];
  let total = 0;
  for (const [re, limit] of LIMIT)
    for (const [path, text] of Object.entries(files)) {
      if (!re.test(path) || picked.some((p) => p.startsWith(`<file path="${path}">`)) || total > 75_000) continue;
      const body = `<file path="${path}">\n${text.slice(0, limit)}\n</file>`;
      picked.push(body);
      total += body.length;
    }
  return picked.join("\n\n");
}

// A short file list: the top levels in full, deeper paths only for the files that show structure.
export function fileList(paths: string[]): string {
  const KEY = /(^|\/)(package\.json|pyproject\.toml|Cargo\.toml|go\.mod|Dockerfile|(docker-)?compose[\w.-]*\.ya?ml|main\.\w+|index\.\w+|app\.\w+|server\.\w+|manage\.py|schema\.prisma|settings\.py|routes?\.\w+|worker\.\w+)$/;
  const shallow = paths.filter((p) => p.split("/").length <= 2);
  const deep = paths.filter((p) => p.split("/").length > 2 && KEY.test(p) && !/(^|\/)(tests?|examples?|fixtures?|docs?)\//.test(p));
  const out = [...new Set([...shallow.slice(0, 250), ...deep.slice(0, 150)])];
  return `${out.join("\n")}${paths.length > out.length ? `\n(${paths.length - out.length} more files)` : ""}`;
}

export function prompt(f: Facts, found: Finding[], kind: { label: string } | null, files: Record<string, string> = f.texts, paths: string[] = f.paths): string {
  const list = found
    .filter((x) => x.status !== "n/a")
    .map((x) => `- ${x.id} [${x.status ?? x.level}${x.priority ? `, ${x.priority}` : ""}] ${x.title}: ${x.text}`)
    .join("\n");
  const read = Object.keys(files).length;
  const whole = read >= paths.length * 0.5 || Boolean(f.archive);
  return `Repository: ${f.repo.fullName}${f.repo.description ? ` (${f.repo.description})` : ""}${kind ? `\nLooks like: ${kind.label}` : ""}

<coverage>
${whole ? `The whole repo was read (${read} of ${paths.length} files; binaries, vendored and build files skipped).` : `Only ${read} of ${paths.length} files were read: the repo was too large to download, so only its main files (README, license, root manifests) were. The file list is complete.`} Nothing was installed, built or run.
</coverage>

<findings>
${list}
</findings>

<file_list>
${fileList(paths)}
</file_list>

<files>
${excerpts(files)}
</files>`;
}

export type Dispute = { id: string; reason: string; quote: string; evidence: Finding["evidence"] };
export type Review = { decision: Decision; architecture: Architecture | null; findings: Finding[]; disputes: Dispute[]; usage: Usage };
// An answer that came back unusable (cut off, refused, didn't match the schema) still cost what it used.
export type Failed = { failed: string; usage: Usage };

export async function aiReview(
  f: Facts,
  found: Finding[],
  opts: { client?: Anthropic; files?: Record<string, string>; paths?: string[]; kind?: { kind: ProjectKind; label: string } | null; link?: (path: string) => string } = {},
): Promise<Review | Failed> {
  const client = opts.client ?? new Anthropic();
  const files = opts.files ?? f.texts;
  const paths = opts.paths ?? f.paths;
  const link = opts.link ?? ((p: string) => `${f.repo.htmlUrl}/blob/${f.commit ?? f.repo.defaultBranch}/${p}`);
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: MAX_OUTPUT,
    output_config: { effort: "medium", format: zodOutputFormat(Out) }, // Haiku at "low" skips the architecture
    system: SYSTEM,
    messages: [{ role: "user", content: prompt(f, found, opts.kind ?? null, files, paths) }],
  });
  const out = res.parsed_output;
  if (!out || res.stop_reason !== "end_turn") return { failed: String(res.stop_reason ?? "no output"), usage: res.usage };

  // Quotes are checked against every file read, in squashed form (markdown and spacing don't matter).
  const squashed = new Map<string, string>();
  const inFile = (path: string, q: string) => {
    if (!(path in files)) return false;
    if (!squashed.has(path)) squashed.set(path, squash(files[path]));
    return squashed.get(path)!.includes(q);
  };
  const locate = (file: string, quote: string) => {
    const q = squash(quote);
    if (q.split(" ").length < 4) return null;
    if (inFile(file, q)) return file;
    return Object.keys(files).find((p) => inFile(p, q)) ?? null;
  };
  const kept: Finding[] = [];
  out.findings.slice(0, 5).forEach((x, i) => {
    x.quotes = x.quotes.slice(0, 2);
    const where = x.quotes.map((q) => locate(q.file, q.text));
    if (where.some((w) => !w)) return;
    const lineOf = (path: string, quote: string) => {
      const text = files[path];
      let at = text.indexOf(quote.trim().split("\n")[0].slice(0, 40));
      // Quotes are matched ignoring markdown and spacing, so look for the first few words the same way.
      if (at < 0) {
        const words = squash(quote).split(" ").slice(0, 6).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        at = new RegExp(words.join("[\\s*_`>#-]+"), "i").exec(text)?.index ?? -1;
      }
      return at >= 0 ? text.slice(0, at).split("\n").length : undefined;
    };
    kept.push({
      id: `ai.${x.headline}.${i}`,
      section: SECTION[x.headline],
      headline: x.headline === "setup" || x.headline === "use" || x.headline === "security" ? undefined : (x.headline as HeadlineId),
      level: x.level,
      status: x.level === "good" ? "pass" : "concern",
      priority: x.level === "good" ? undefined : x.priority === "blocker" || (x.priority === "important" && CAP[x.headline] === "improvement") ? CAP[x.headline] : x.priority,
      kind: "inferred",
      title: x.title.length <= 70 ? x.title : `${x.title.slice(0, 68).replace(/\s+\S*$/, "")}…`,
      text: x.text.slice(0, 500),
      action: x.level === "good" ? undefined : `Suggestion: ${x.action.slice(0, 300)}`,
      quote: x.quotes.map((q) => q.text.slice(0, 300)).join(" … "),
      evidence: where
        .map((w, j) => {
          const line = lineOf(w!, x.quotes[j].text);
          return { label: line ? `${w}:${line}` : w!, url: `${link(w!)}${line ? `#L${line}` : ""}`, path: w!, line };
        })
        .filter((e, j, all) => all.findIndex((o) => o.url === e.url) === j), // two quotes from one place: one link
    });
  });

  // Architecture: only paths that exist.
  const exists = new Set(paths);
  const dirs = new Set(paths.flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));
  const architecture =
    out.architecture && out.architecture.parts.length
      ? {
          summary: out.architecture.summary.slice(0, 400),
          parts: out.architecture.parts
            .slice(0, 8)
            .map((p) => ({ name: p.name.slice(0, 40), role: p.role.slice(0, 200), paths: p.paths.slice(0, 3).map((x) => x.replace(/^\.?\//, "").replace(/\/$/, "")).filter((x) => exists.has(x) || dirs.has(x)) }))
            .filter((p) => p.paths.length),
          links: [] as { from: string; to: string; label: string }[],
        }
      : null;
  // Disputes of rule findings, kept only with quotes found in the files, like added findings.
  const disputes: Dispute[] = [];
  for (const d of (out.disputes ?? []).slice(0, 4)) {
    if (!found.some((x) => x.id === d.id)) continue;
    d.quotes = d.quotes.slice(0, 2);
    const where = d.quotes.map((q) => locate(q.file, q.text));
    if (where.some((w) => !w)) continue;
    disputes.push({
      id: d.id,
      reason: d.reason.slice(0, 400),
      quote: d.quotes.map((q) => q.text.slice(0, 300)).join(" … "),
      evidence: where.map((w) => ({ label: w!, url: link(w!), path: w! })),
    });
  }
  // Links only between parts that survived the path check.
  if (architecture && out.architecture) {
    const names = new Set(architecture.parts.map((p) => p.name));
    architecture.links = (out.architecture.links ?? [])
      .map((l) => ({ from: l.from.slice(0, 40), to: l.to.slice(0, 40), label: l.label.slice(0, 30) }))
      .filter((l, i, all) => names.has(l.from) && names.has(l.to) && l.from !== l.to && all.findIndex((o) => o.from === l.from && o.to === l.to) === i)
      .slice(0, 14);
  }
  const cut = (xs: string[], n: number) => xs.map((x) => x.slice(0, 240)).slice(0, n);
  return {
    decision: { does: out.does.slice(0, 500), needs: cut(out.needs, 8), blockers: cut(out.blockers, 6), first: cut(out.first, 5), business: out.business.slice(0, 500) },
    architecture: architecture && architecture.parts.length ? architecture : null,
    findings: kept,
    disputes,
    usage: res.usage,
  };
}

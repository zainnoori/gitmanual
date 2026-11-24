import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetError, release, reserve, settle, usageCost } from "./budget";
import { saveSummary, summaryHash } from "./db";

// The manual's subtitle (app/about.tsx): a short plain summary of the README, written by Claude (Haiku) once per README
// and saved, so reading a manual never calls Claude. It's written after a manual is read from GitHub (a new manual or
// a re-read), only when the README changed since the last summary, so it costs nothing for bots or saved copies.

export const SUMMARY_MODEL = "claude-haiku-5-5" as const;
const MAX_README = 15_000; // characters of README sent (about 5K tokens)
const MIN_README = 400; // shorter READMEs say little more than the description
const MAX_OUTPUT = 900;

export type { RepoSummary } from "./db";
import type { RepoSummary } from "./db";

const Out = z.object({
  what: z.string(),
  goodFor: z.array(z.string()),
  notFor: z.array(z.string()),
  features: z.array(z.string()),
});

const SYSTEM = `You summarize an open source repository for people deciding whether to install it. You get its GitHub description, topics and README.

Write, in English (translate if the README is in another language):
- what: two or three plain sentences on what it is and what someone can do with it. Name the kind of thing (app, command-line tool, library, browser extension, self-hosted service, template...).
- goodFor: up to 3 short phrases (at most 12 words each) on who or what it suits ("Gamers checking wireless mouse battery").
- notFor: up to 2 short phrases (at most 12 words each), only when the README says so or it's plainly limited (one system only, a demo, unmaintained). Empty otherwise.
- features: up to 5 main features, at most 8 words each.

Only use what the description and README say. Don't guess, don't praise, no marketing words ("powerful", "seamless", "blazing"), never say it's safe. No install steps, links or code. Leave a list empty rather than pad it.`;

export const readmeHash = (readme: string) => createHash("sha256").update(readme).digest("hex").slice(0, 32);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const tidy = (xs: string[], max: number, len: number) => xs.map((x) => clip(x.replace(/\s+/g, " ").trim(), len)).filter(Boolean).slice(0, max);

// What one summary can cost at most, held before Claude is called (millionths of a dollar).
const WORST = usageCost(SUMMARY_MODEL, { input_tokens: Math.ceil((MAX_README + 2_000) / 3), output_tokens: MAX_OUTPUT });

type Input = { key: string; fullName: string; description: string | null; topics: string[]; readme: string | undefined };

// Writes and saves a new summary when this README hasn't got one. Never throws: the manual is fine without it.
export async function summarize(r: Input, opts: { client?: Anthropic } = {}): Promise<RepoSummary | null> {
  if (process.env.SUMMARIES === "off" || (!opts.client && !process.env.ANTHROPIC_API_KEY)) return null;
  const readme = r.readme?.trim();
  if (!readme || readme.length < MIN_README) return null;
  const hash = readmeHash(readme);
  try {
    if ((await summaryHash(r.key)) === hash) return null; // already summarized this README
    // One per README version for the whole site: a second server writing the same one is turned away as a duplicate.
    const reservation = await reserve({ pool: "summary", account: "site", requestId: `sum-${hash}`, model: SUMMARY_MODEL, repo: r.key, amount: WORST });
    if (reservation.duplicate) return null;
    let spent = false;
    try {
      const client = opts.client ?? new Anthropic();
      const res = await client.messages.parse({
        model: SUMMARY_MODEL,
        max_tokens: MAX_OUTPUT,
        output_config: { effort: "low", format: zodOutputFormat(Out) },
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `<repo>${r.fullName}</repo>\n<description>${r.description ?? ""}</description>\n<topics>${r.topics.join(", ")}</topics>\n<readme>\n${readme.slice(0, MAX_README)}\n</readme>`,
          },
        ],
      });
      spent = true;
      await settle(reservation.key, SUMMARY_MODEL, [res.usage]);
      const out = res.parsed_output;
      if (!out || res.stop_reason !== "end_turn" || !out.what.trim()) return null;
      const summary: RepoSummary = {
        what: clip(out.what.replace(/\s+/g, " ").trim(), 600),
        goodFor: tidy(out.goodFor, 3, 110),
        notFor: tidy(out.notFor, 2, 110),
        features: tidy(out.features, 5, 90),
      };
      await saveSummary(r.key, hash, summary, SUMMARY_MODEL);
      return summary;
    } finally {
      if (!spent) await release(reservation.key);
    }
  } catch (e) {
    if (!(e instanceof BudgetError)) console.error("gitmanual summary:", e instanceof Error ? e.message : e);
    return null;
  }
}

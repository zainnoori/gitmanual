import { OS_LIST, type OS } from "./os";

// Problem reports and messages (app/report-problem.tsx, app/api/problems), read on /admin/problems. Three forms:
// "Something wrong with this manual?" on a manual (repo, system and step filled in), "Report a problem" in the
// footer (payments, signing in, a broken page), and "Contact" (questions, feedback, advertising).
export const PROBLEM_KINDS = [
  { id: "step", label: "A step failed" },
  { id: "system", label: "Wrong for my system" },
  { id: "missing", label: "A step is missing" },
  { id: "question", label: "I have a question" },
  { id: "other", label: "Something else" },
] as const;
export const SITE_KINDS = [
  { id: "payment", label: "Payment or Pro" },
  { id: "account", label: "Signing in or my account" },
  { id: "site", label: "Something on the site is broken" },
  { id: "manual", label: "A manual is wrong" },
  { id: "question", label: "I have a question" },
  { id: "other", label: "Something else" },
] as const;
export const CONTACT_KINDS = [
  { id: "question", label: "A question" },
  { id: "feedback", label: "Feedback or an idea" },
  { id: "advertising", label: "Advertising" },
  { id: "maintainer", label: "My repo's manual" },
  { id: "other", label: "Something else" },
] as const;
export type ProblemKind = (typeof PROBLEM_KINDS)[number]["id"] | (typeof SITE_KINDS)[number]["id"] | (typeof CONTACT_KINDS)[number]["id"];
export type ProblemMode = "manual" | "site" | "contact";
const KINDS_FOR: Record<ProblemMode, readonly { id: string }[]> = { manual: PROBLEM_KINDS, site: SITE_KINDS, contact: CONTACT_KINDS };
export const KIND_LABEL: Record<string, string> = Object.fromEntries([...CONTACT_KINDS, ...SITE_KINDS, ...PROBLEM_KINDS].map((k) => [k.id, k.label]));
// About money or an account: nobody can sort it out without a way to reply.
export const needsEmail = (kind: string) => kind === "payment" || kind === "account";

export const PROBLEM_LIMITS = { message: 2000, error: 4000, email: 200, stepTitle: 200, page: 300, name: 100 };

export type ProblemInput = {
  mode: ProblemMode;
  name: string | null; // contact: how to address them
  repo: string; // "" when it's about the site, not one manual
  os: OS | "";
  kind: ProblemKind;
  step: number | null;
  stepTitle: string | null;
  message: string;
  error: string | null;
  email: string | null;
  page: string | null; // the page it was sent from
  version: number; // the manual's analysis version they were reading (0 for the site)
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[\w.-]+$/;

// The checked report, or the reason it can't be sent (shown as is).
export function checkProblem(body: Record<string, unknown>): ProblemInput | string {
  const kind = body.kind as ProblemKind;
  const mode: ProblemMode = body.mode === "contact" || body.mode === "site" || body.mode === "manual" ? body.mode : text(body.os, 10) ? "manual" : "site";
  const site = mode !== "manual"; // no system, no step
  if (!KINDS_FOR[mode].some((k) => k.id === kind)) return mode === "contact" ? "Pick what your message is about." : "Pick what kind of problem it is.";
  // From a manual the repo comes with it; from the footer it's optional (a manual they mean), "owner/name" or a link.
  const repo = text(body.repo, 200).replace(/^https?:\/\/(www\.)?(github\.com|gitmanual\.com)\//i, "").replace(/\/+$/, "");
  if (repo ? !REPO.test(repo) : !site) return site ? "Write the repo as owner/name, or leave it empty." : "Which repo is this about?";
  const os = site ? "" : (body.os as OS);
  if (os && !OS_LIST.includes(os)) return "Which system is this about?";
  const message = text(body.message, PROBLEM_LIMITS.message);
  if (message.length < 5) return "Tell us a little more about what happened.";
  const step = !site && typeof body.step === "number" && Number.isInteger(body.step) && body.step > 0 && body.step < 100 ? body.step : null;
  const email = text(body.email, PROBLEM_LIMITS.email) || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email address doesn't look right.";
  if (!email && (needsEmail(kind) || (mode === "contact" && kind !== "feedback"))) return "Add your email so we can get back to you about this.";
  const page = text(body.page, PROBLEM_LIMITS.page);
  return {
    mode,
    name: mode === "contact" ? text(body.name, PROBLEM_LIMITS.name) || null : null,
    repo,
    os,
    kind,
    step,
    stepTitle: step ? text(body.stepTitle, PROBLEM_LIMITS.stepTitle) || null : null,
    message,
    error: text(body.error, PROBLEM_LIMITS.error) || null,
    email,
    page: page.startsWith("/") ? page : null,
    version: !site && typeof body.version === "number" && Number.isInteger(body.version) && body.version >= 0 && body.version < 10000 ? body.version : 0,
  };
}

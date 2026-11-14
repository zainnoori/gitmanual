// Deep Inspection (Pro): requirements, maintenance, risks and gaps to review before adopting a public repo, from facts collected once (collect.ts),
// turned into findings by plain rules (rules.ts), and worded for people by Claude (ai.ts). Saved per repo and shared
// by every Pro member who opens it (index.ts).

export type Level = "good" | "note" | "risk" | "neutral";

// The parts of the report. "headline" holds "Key findings"; the rest are the sections below it.
export type SectionId =
  | "license" | "control" | "activity" | "releases" | "people" | "responsiveness" | "community" | "security" | "dependencies" | "supply" | "privacy" | "popularity" | "cost"
  // "Before you run it": what the README says against what the files show.
  | "setup" | "config" | "services" | "requirements" | "tests" | "deploy" | "secrets";

// How a finding is known. Execution (actually installing and running it) comes later; nothing claims it yet.
//   documented: the repo's own docs say so · detected: found in its files by a rule · reported: from GitHub, CI or
//   another service (OSV, Scorecard) · inferred: Claude's reading, backed by quotes checked against the files.
export type EvidenceKind = "documented" | "detected" | "reported" | "inferred";
// How much it matters to someone about to use it.
export type Priority = "blocker" | "important" | "improvement";
// The outcome of a check. "Not found" always means "not found in the files read", never "doesn't exist".
export type Status = "pass" | "concern" | "info" | "not-found" | "not-checked" | "n/a";
export type Evidence = { label: string; url?: string; path?: string; line?: number };

export type Finding = {
  id: string; // stable, for tests and for the AI step to refer to
  section: SectionId;
  level: Level;
  title: string; // a few words: "No license"
  text: string; // one plain sentence with the numbers
  evidence?: Evidence[];
  status?: Status; // filled in from the level when a rule doesn't set it (see rules.finish)
  kind?: EvidenceKind;
  priority?: Priority; // only for concerns
  action?: string; // a concrete next step; anything generated is labelled a suggestion
  weight?: number; // how much it matters for its grade (1 by default)
  headline?: HeadlineId; // which headline question it answers, for findings the AI step adds
  quote?: string; // the AI step's evidence: words copied from the repo's own files, checked before it's kept
};

// The 12 questions at the top of every inspection. Each is answered by findings, or left out when nothing applies.
export const HEADLINE = [
  { id: "open", q: "Is it really open source?", sections: ["license"] },
  { id: "obligations", q: "What you must do to use it", sections: ["license"] },
  { id: "control", q: "Who really controls it", sections: ["control"] },
  { id: "changes", q: "Recent changes in control", sections: ["control"] },
  { id: "free", q: "License and paid offerings", sections: ["license", "control"] },
  { id: "alive", q: "Is it still alive?", sections: ["activity", "releases"] },
  { id: "responds", q: "Who answers issues?", sections: ["responsiveness"] },
  { id: "vulns", q: "Known vulnerabilities", sections: ["security", "dependencies"] },
  { id: "trust", q: "Can you trust what you download?", sections: ["supply"] },
  { id: "data", q: "Telemetry and analytics", sections: ["privacy"] },
  { id: "popularity", q: "Adoption signals", sections: ["popularity"] },
  { id: "cost", q: "What it costs to run", sections: ["cost"] },
] as const;
export type HeadlineId = (typeof HEADLINE)[number]["id"];

export type Grade = "A" | "B" | "C" | "D" | "F";
export type GradeId = "maintenance" | "continuity" | "community" | "security" | "openness";
export type Grades = { overall: Grade | null; parts: Partial<Record<GradeId, { grade: Grade; score: number; reasons: string[]; held?: boolean }>> };

// The answer to one headline question, as shown: a short verdict and the sentence behind it.
export type Answer = { id: HeadlineId; level: Level; verdict: string; text: string; findings: string[] };

// For the Personal / Business switch: what each kind of reader should look at first.
export type Audience = "personal" | "business";

// What kind of project it is: decides which checks apply. A command-line formatter isn't marked down for having
// no database backups.
export type ProjectKind = "app" | "cli" | "library" | "desktop" | "mobile" | "extension" | "plugin" | "template" | "docs" | "other";

// What was inspected, so every finding can be traced to one commit.
export type Scope = {
  branch: string;
  commit: string | null;
  archive: boolean; // the whole repo was read (false: only the main files, through the API)
  filesInRepo: number;
  filesRead: number;
  skipped: { reason: string; count: number; examples: string[] }[];
  coverage?: Coverage;
};

// How far each kind of evidence reaches, so no conclusion is read as covering more than was looked at.
export type Coverage = {
  listComplete: boolean; // every path in the repo was listed (GitHub cuts very large trees short)
  manifests: { found: number; read: number }; // package.json, pyproject.toml, Cargo.toml, go.mod...
  deps: { total: number; checked: number; cap: number } | null; // from GitHub's dependency list, checked against OSV.dev
  commits: { count: number; since: string | null } | null; // the latest commits on the default branch
  issues: { count: number; since: string | null } | null; // the latest issues, for who answers
  releases: number | null;
  executed: false; // nothing is installed, built or run (yet)
};

// Claude's short decision summary at the top. Every point is drawn from the findings.
export type Decision = {
  does: string; // what the project does and who it's for
  needs: string[]; // what you need to run it
  blockers: string[]; // the main blockers and uncertainties
  first: string[]; // what to look at or fix first
  business: string; // one or two sentences for a business deciding whether to adopt it
};

// The main parts and how they connect, from Claude; every path is checked to exist.
export type Architecture = { summary: string; parts: { name: string; role: string; paths: string[] }[]; links?: { from: string; to: string; label: string }[] };

// The documented way to get it running, one step per phase, with the checks that concern each step.
export type StepPhase = "get" | "install" | "configure" | "services" | "database" | "build" | "run";
export type SetupStep = { phase: StepPhase; command: string; doc: string; line: number; findings: string[] };

export type Inspection = {
  version: number;
  repo: string; // owner/name as GitHub spells it
  scannedAt: number;
  facts: import("./collect").Facts;
  findings: Finding[];
  headline: Answer[];
  summary: { personal: string; business: string } | null; // two or three sentences each, from Claude (version 1)
  decision?: Decision | null;
  architecture?: Architecture | null;
  steps?: SetupStep[];
  kind?: { kind: ProjectKind; label: string; why: string };
  scope?: Scope;
  grades: Grades;
  unavailable: string[]; // the parts that couldn't be checked this time, in plain words
};

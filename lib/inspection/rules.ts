import type { Facts, Thread } from "./collect";
import { HEADLINE, type Answer, type EvidenceKind, type Finding, type Grade, type GradeId, type Grades, type HeadlineId, type Level, type SectionId, type Status } from "./types";

// Facts in, findings out: plain rules, no guessing. Wording is factual ("no release in 14 months"), never a verdict
// like "unsafe"; a check that doesn't apply says nothing rather than counting against the repo. Expectations scale
// with the repo's size, so a weekend project isn't judged like a platform thousands depend on.

const DAY = 24 * 60 * 60 * 1000;
// The audit command for the lock files the repo has.
const AUDIT: [RegExp, string][] = [
  [/(^|\/)yarn\.lock$/, "yarn npm audit, or yarn audit on Yarn 1"], [/(^|\/)pnpm-lock\.yaml$/, "pnpm audit"], [/(^|\/)bun\.lockb?$/, "bun audit"],
  [/(^|\/)(package-lock|npm-shrinkwrap)\.json$/, "npm audit"], [/(^|\/)(poetry\.lock|uv\.lock|Pipfile\.lock|requirements[\w.-]*\.txt|pyproject\.toml)$/, "pip-audit"],
  [/(^|\/)Cargo\.lock$/, "cargo audit"], [/(^|\/)go\.sum$/, "govulncheck"], [/(^|\/)Gemfile\.lock$/, "bundle audit"], [/(^|\/)composer\.lock$/, "composer audit"],
];
const audit = (paths: string[]) => {
  const hits = AUDIT.filter(([re]) => paths.some((p) => re.test(p) && !/(^|\/)(node_modules|vendor)\//.test(p))).map(([, c]) => c);
  return hits.length ? hits.slice(0, 2).join("; ") : "your package manager's audit command";
};
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|pdm\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/;
const daysSince = (iso: string | null | undefined, now: number) => (iso ? Math.floor((now - Date.parse(iso)) / DAY) : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const span = (days: number) =>
  days < 2 ? plural(Math.max(1, Math.round(days * 24)), "hour") : days < 60 ? `${Math.round(days)} days` : days < 730 ? `${Math.round(days / 30)} months` : `${(days / 365).toFixed(1).replace(/\.0$/, "")} years`;
const when = (iso: string) => new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// How big a deal the repo is: sets what's expected of it.
export type Tier = "small" | "medium" | "large";
export function tier(f: Facts): Tier {
  const people = f.contributors?.length ?? 0;
  if (f.repo.stars >= 5000 || people >= 50) return "large";
  if (f.repo.stars >= 300 || people >= 8) return "medium";
  return "small";
}

// ── Licenses ────────────────────────────────────────────────────────────────────────────────────────────────────
export type LicenseKind = "permissive" | "public-domain" | "weak-copyleft" | "copyleft" | "network-copyleft" | "source-available" | "non-commercial" | "mixed" | "none" | "unknown";

const BY_SPDX: [RegExp, LicenseKind][] = [
  [/^(Unlicense|CC0-1\.0|0BSD|WTFPL)$/i, "public-domain"],
  [/^(MIT|MIT-0|ISC|Zlib|BSL-1\.0|Apache-2\.0|BSD-[234]-Clause.*|PostgreSQL|NCSA|UPL-1\.0|MS-PL|Artistic-2\.0|MulanPSL-2\.0|Python-2\.0|X11)$/i, "permissive"],
  [/^(MPL-2\.0|LGPL-[23]\.[01].*|EPL-[12]\.0|EUPL-1\.[12]|CDDL-1\.[01]|OSL-3\.0|MS-RL)$/i, "weak-copyleft"],
  [/^AGPL-3\.0/i, "network-copyleft"],
  [/^GPL-[23]\.0/i, "copyleft"],
  [/^(BUSL-1\.1|SSPL-1\.0|Elastic-2\.0|FSL-1\.[01].*|Commons-Clause|PolyForm-.*|RSAL.*)$/i, "source-available"],
  [/^CC-BY-NC/i, "non-commercial"],
];
const BY_TEXT: [RegExp, LicenseKind, string][] = [
  [/Business Source License/i, "source-available", "Business Source License"],
  [/Server Side Public License/i, "source-available", "Server Side Public License"],
  [/Elastic License/i, "source-available", "Elastic License"],
  [/Functional Source License/i, "source-available", "Functional Source License"],
  [/Commons Clause/i, "source-available", "Commons Clause"],
  [/PolyForm (Noncommercial|Small Business|Shield|Internal Use|Perimeter|Strict)/i, "source-available", "PolyForm"],
  [/Sustainable Use License/i, "source-available", "Sustainable Use License"],
  [/GNU AFFERO GENERAL PUBLIC LICENSE/i, "network-copyleft", "AGPL"],
  [/GNU LESSER GENERAL PUBLIC LICENSE/i, "weak-copyleft", "LGPL"],
  [/GNU GENERAL PUBLIC LICENSE/i, "copyleft", "GPL"],
  [/Mozilla Public License/i, "weak-copyleft", "MPL"],
  [/Apache License/i, "permissive", "Apache"],
  [/Permission is hereby granted, free of charge/i, "permissive", "MIT-style"],
  [/Permission\s+to\s+use,\s+copy,\s+modify,?\s+and\/or\s+distribute\s+this\s+software\s+for\s+any\s+purpose/i, "permissive", "0BSD"],
  // Checked last and strictly: the GPL itself says "noncommercially" about one way of sharing it.
  [/\b(for non-?commercial (use|purposes) only|non-?commercial use only|may not be used for (any )?commercial purposes|Attribution-NonCommercial)\b/i, "non-commercial", "non-commercial license"],
];

export const licenseFiles = (f: Facts) => Object.keys(f.texts).filter((p) => /^(LICEN[CS]E|COPYING)([-_.][\w.-]+)?(\.(md|txt|rst))?$/i.test(p));

// The license a manifest declares: package.json, composer.json, pyproject.toml or Cargo.toml.
export function declaredLicense(f: Facts): { id: string; file: string } | null {
  for (const file of ["package.json", "composer.json"]) {
    try {
      const j = JSON.parse(f.texts[file] ?? "null") as { license?: unknown } | null;
      const l = typeof j?.license === "string" ? j.license : Array.isArray(j?.license) ? String(j!.license[0]) : null;
      if (l && !/^(UNLICENSED|proprietary|SEE LICENSE)/i.test(l)) return { id: l, file };
    } catch {}
  }
  for (const file of ["pyproject.toml", "Cargo.toml"]) {
    const m = /^license\s*=\s*(?:\{\s*text\s*=\s*)?["']([^"']+)["']/m.exec(f.texts[file] ?? "");
    if (m) return { id: m[1], file };
  }
  return null;
}

export function licenseKind(f: Facts): { kind: LicenseKind; name: string } {
  const spdx = f.repo.licenseSpdx;
  if (spdx && spdx !== "NOASSERTION" && spdx.toLowerCase() !== "other") {
    const hit = BY_SPDX.find(([re]) => re.test(spdx));
    if (hit) return { kind: hit[1], name: f.repo.licenseName ?? spdx };
  }
  const files = licenseFiles(f);
  if (!files.length && !spdx) {
    // No license file, but the manifest names one (Laravel's composer.json says MIT): that's what applies.
    const declared = declaredLicense(f);
    if (declared) {
      const hit = BY_SPDX.find(([re]) => re.test(declared.id));
      return { kind: hit ? hit[1] : "unknown", name: `${declared.id} (declared in ${declared.file}, no license file)` };
    }
    // Each part under its own license (anthropics/skills keeps one per skill folder).
    const nested = f.paths.filter((p) => /(^|\/)(LICEN[CS]E|COPYING)([-_.][\w.-]+)?$/i.test(p) && p.includes("/") && !/(^|\/)(node_modules|vendor|third[-_]?party|external)\//i.test(p));
    if (nested.length) return { kind: "mixed", name: `licenses per folder (${nested.length} files, such as ${nested[0]})` };
    return { kind: "none", name: "No license" };
  }
  // Each license file on its own: a repo can put different parts under different licenses.
  const kinds = files
    // The license's own name is at the top; deeper in, licenses mention each other (GPLv3 refers to the AGPL).
    .map((p) => BY_TEXT.find(([re]) => re.test(f.texts[p].slice(0, 2000))))
    .filter((x): x is [RegExp, LicenseKind, string] => Boolean(x));
  const names = [...new Set(kinds.map((k) => k[2]))];
  if (new Set(kinds.map((k) => k[1])).size > 1) return { kind: "mixed", name: names.join(", ") };
  return kinds[0] ? { kind: kinds[0][1], name: kinds[0][2] } : { kind: "unknown", name: f.repo.licenseName && f.repo.licenseName !== "Other" ? f.repo.licenseName : "a custom license" };
}

const OBLIGATIONS: Record<LicenseKind, { personal: string; business: string; level: Level }> = {
  permissive: { level: "good", personal: "Use it freely.", business: "Keep the copyright and license notice when you ship it. You can use it in closed-source and paid products." },
  "public-domain": { level: "good", personal: "Use it freely.", business: "No conditions; some companies still ask legal to confirm public-domain dedications." },
  "weak-copyleft": { level: "note", personal: "Use it freely.", business: "If you change its own files and ship them, share those changes under the same license. Your own code that uses it can stay closed." },
  copyleft: { level: "note", personal: "Use it freely.", business: "If you ship a product that includes or links it, the whole product must be released under the GPL with its source. Running it internally has no such duty." },
  "network-copyleft": { level: "note", personal: "Use it freely.", business: "If people use a version you changed over a network (for example as a web service), you must offer them your source code. Many companies don't allow AGPL without review." },
  "source-available": { level: "risk", personal: "Usually free to use yourself; read the terms.", business: "Not open source: some uses, often offering it as a hosted or competing service, are restricted or need a paid license." },
  "non-commercial": { level: "risk", personal: "Free for personal, non-commercial use.", business: "Commercial use isn't allowed without a separate agreement." },
  mixed: { level: "note", personal: "Use it freely.", business: "Different parts carry different licenses, so the duties depend on which parts you ship. Check the license of each part you use." },
  none: { level: "risk", personal: "Legally you have no permission to use, copy or change it, though owners rarely object to personal use.", business: "No permission to use it: legally all rights are reserved. Ask the owner for a license before using it." },
  unknown: { level: "note", personal: "Read the license to see what's allowed.", business: "It uses a license gitmanual couldn't classify. Have it reviewed before use in a product." },
};

// ── Findings ────────────────────────────────────────────────────────────────────────────────────────────────────
export type Extra = { paidAi?: string[]; requested?: string }; // from the manual's analysis; the name that was asked for

export function findings(f: Facts, extra: Extra = {}, now = f.collectedAt): Finding[] {
  const out: Finding[] = [];
  const add = (x: Finding) => out.push(x);
  const size = tier(f);
  const url = f.repo.htmlUrl;
  const readme = Object.entries(f.texts).find(([p]) => /^README/i.test(p))?.[1] ?? "";
  const docs = Object.entries(f.texts)
    .filter(([p]) => /^(README|docs?\/|PRIVACY|TELEMETRY)/i.test(p))
    .map(([, t]) => t)
    .join("\n");
  const manifests = Object.entries(f.texts)
    .filter(([p]) => /(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle)/i.test(p))
    .map(([, t]) => t)
    .join("\n");
  const contributing = Object.entries(f.texts).find(([p]) => /CONTRIBUTING/i.test(p))?.[1] ?? "";
  const workflows = Object.entries(f.texts).filter(([p]) => /^\.github\/workflows\//.test(p));
  const has = (re: RegExp) => f.paths.some((p) => re.test(p));
  const file = (re: RegExp) => f.paths.find((p) => re.test(p));
  // Pinned to the inspected commit, so a link shows exactly what was read.
  const ref = f.commit ?? f.repo.defaultBranch;
  const link = (path: string) => `${url}/blob/${ref}/${path}`;

  // License: what kind, what it asks of you, and whether it changed.
  const lic = licenseKind(f);
  const licFile = licenseFiles(f)[0];
  const ob = OBLIGATIONS[lic.kind];
  const KIND_TEXT: Record<LicenseKind, string> = {
    permissive: `Open source under a permissive license (${lic.name}).`,
    "public-domain": `Public domain or close to it (${lic.name}).`,
    "weak-copyleft": `Open source under a weak copyleft license (${lic.name}): changes to its own files must stay open.`,
    copyleft: `Open source under a copyleft license (${lic.name}): anything you ship that includes it must be open too.`,
    "network-copyleft": `Open source under the AGPL (${lic.name}): even offering it as a web service counts as sharing it.`,
    "source-available": `Not open source: it uses the ${lic.name}, a "source-available" license that restricts some uses.`,
    "non-commercial": `Not open source: the license (${lic.name}) doesn't allow commercial use.`,
    none: "There's no license, so legally all rights are reserved: nobody else may use, copy or change it without permission.",
    unknown: `It uses ${lic.name} that isn't a standard open source license; read it before relying on it.`,
    mixed: `Different parts are under different licenses (${lic.name}).`,
  };
  add({
    id: lic.kind === "none" ? "license.none" : "license.kind",
    section: "license",
    level: lic.kind === "permissive" || lic.kind === "public-domain" ? "good" : lic.kind === "weak-copyleft" || lic.kind === "copyleft" || lic.kind === "network-copyleft" || lic.kind === "unknown" || lic.kind === "mixed" ? "note" : "risk",
    title: lic.kind === "none" ? "No license" : lic.name,
    text: KIND_TEXT[lic.kind],
    evidence: licFile ? [{ label: licFile, url: link(licFile) }] : undefined,
    weight: 2,
  });
  if (/no license file\)$/.test(lic.name))
    add({ id: "license.file", section: "license", level: "note", title: "License declared, no license file", text: `Its ${lic.name.replace(/^.*declared in ([^,]+),.*$/, "$1")} says ${lic.name.split(" (")[0]}, but there's no LICENSE file with the full terms. The declared license most likely applies; if it matters, ask the maintainers to add the file.` });
  add({ id: "license.obligations", section: "license", level: ob.level === "risk" ? "note" : "neutral", title: "Your obligations", text: `For yourself: ${ob.personal} For a business: ${ob.business}` });

  const extraLicenses = licenseFiles(f).filter((p) => p !== licFile);
  const eeDir = f.paths.find((p) => /^(ee|enterprise|commercial|premium)\//i.test(p) || /\/(ee|enterprise)\//i.test(p));
  const eeFiles = f.paths.filter((p) => /\.ee\.[cm]?[jt]sx?$/i.test(p)).length;
  const enterpriseText = /\b(enterprise edition|commercial license|paid (plan|tier|version)|pro version|cloud version|self-hosted (plan|edition))\b/i.exec(readme);
  // The folder that holds the paid part, e.g. "ee" or "packages/enterprise".
  const eeFolder = eeDir ? eeDir.split("/").slice(0, eeDir.split("/").findIndex((s) => /^(ee|enterprise|commercial|premium)$/i.test(s)) + 1).join("/") : null;
  // Open core needs a separate license file for the paid part (in its folder, or named for it). A folder called
  // "enterprise" or files marked ".ee" without one are only a lead: the license scope is left as a question.
  const eeLicense =
    (eeFolder ? f.paths.find((p) => p.startsWith(`${eeFolder}/`) && /^(LICEN[CS]E|COPYING)[^/]*$/i.test(p.slice(eeFolder.length + 1))) : undefined) ??
    [...extraLicenses, ...f.paths.filter((p) => /(^|\/)(LICEN[CS]E|COPYING)[^/]*$/i.test(p))].find((p) => /(^|\/)(ee|enterprise|commercial)\/(LICEN[CS]E|COPYING)|LICEN[CS]E[._-]?(EE|ENTERPRISE|COMMERCIAL)/i.test(p)) ??
    null;
  if (eeLicense)
    add({
      id: "license.opencore",
      section: "license",
      level: "note",
      title: "Open core",
      text: `Part of the code has its own license, ${eeLicense}${eeFolder && eeLicense.startsWith(`${eeFolder}/`) ? ` (covering the ${eeFolder} folder)` : ""}, separate from ${licFile ?? "the main license"}. Read it for what that part allows; it's often a paid, non-open license.`,
      evidence: [{ label: eeLicense, url: link(eeLicense) }],
    });
  else if (eeFolder || eeFiles >= 3)
    add({
      id: "license.scope",
      section: "license",
      level: "neutral",
      status: "info",
      title: "License scope to check",
      text: `${eeFolder ? `A folder named ${eeFolder}` : `${plural(eeFiles, "file")} marked ".ee"`} can mean code under separate terms, but no separate license file was found for it${lic.kind !== "none" ? `, so ${licFile ?? "the main license"} appears to cover it` : ""}. Not established either way.`,
      evidence: eeFolder ? [{ label: eeFolder, url: `${url}/tree/${ref}/${eeFolder}` }] : undefined,
    });
  else if (enterpriseText && f.owner?.type === "Organization")
    add({ id: "license.paid", section: "license", level: "neutral", title: "Paid version", text: `The README mentions a paid offering ("${enterpriseText[0]}"), so it's backed by a business.` });

  const cla = file(/^(CLA(\.md)?|\.clabot|cla\.json|\.cla\.json)$/i) || (/contributor license agreement|\bCLA\b/.test(contributing) ? "CONTRIBUTING" : null) || (workflows.some(([, t]) => /cla-assistant|contributor-assistant|\bcla\b/i.test(t)) ? "CLA check in CI" : null);
  const dco = file(/^\.github\/dco\.ya?ml$/i) || (/\bDCO\b|Developer Certificate of Origin|Signed-off-by/i.test(contributing) ? "CONTRIBUTING" : null);
  if (cla)
    add({
      id: "license.cla",
      section: "license",
      level: f.owner?.type === "Organization" && lic.kind !== "source-available" ? "note" : "neutral",
      title: "Contributor agreement (CLA)",
      text: "Contributors sign a license agreement that gives the owner extra rights over their code, which is what lets an owner relicense future versions (as MongoDB, Elastic and HashiCorp did). Released versions keep their license.",
      evidence: [{ label: cla }],
    });
  else if (dco)
    add({ id: "license.dco", section: "license", level: "good", title: "DCO instead of a CLA", text: "Contributors only certify they wrote their code (DCO); nobody gains the right to relicense it." });

  // Only commits that say they change the license: typo fixes and year bumps in the file don't count.
  const RELICENSE = /\b(relicens\w*|chang\w* (the )?licen[cs]e|licen[cs]e (change|switch)\w*|switch\w* (the )?licen[cs]e|(move|switch|change|licen[cs]e)\w* (it )?to (the )?(BUSL|BSL|SSPL|AGPL|GPL|LGPL|MPL|MIT|Apache|Elastic|0BSD|FSL|PolyForm)|(to|from) (BUSL|BSL|SSPL|Elastic License|AGPL|0BSD)|Business Source License|Server Side Public License)\b/i;
  const changes = (f.licenseHistory ?? []).filter((c) => daysSince(c.date, now)! < 5 * 365 && RELICENSE.test(c.message) && Math.abs(Date.parse(c.date) - Date.parse(f.repo.createdAt)) > 30 * DAY);
  if (changes.length)
    add({
      id: "license.changed",
      section: "license",
      level: lic.kind === "source-available" || lic.kind === "non-commercial" ? "risk" : "note",
      title: "License changed",
      text:
        changes.length === 1
          ? `The license changed on ${when(changes[0].date)} ("${changes[0].message.slice(0, 90)}").`
          : `The license changed ${changes.length} times in the last 5 years: first on ${when(changes[changes.length - 1].date)} ("${changes[changes.length - 1].message.slice(0, 90)}"), most recently on ${when(changes[0].date)}.`,
      evidence: licFile ? [{ label: "License history", url: `${url}/commits/${f.repo.defaultBranch}/${licFile}` }] : undefined,
    });

  const model = /\b(llama (\d )?community license|openrail|CreativeML|model (weights|license)|weights are (released|licensed|available) under|Gemma Terms of Use|cc-by-nc)\b/i.exec(docs);
  if (model)
    add({ id: "license.model", section: "license", level: "note", title: "Separate model license", text: `It mentions AI model weights with their own terms ("${model[0]}"). The code's license doesn't cover them: check the model's license too.` });

  // Who controls it.
  const people = (f.contributors ?? []).filter((c) => c.commits > 0);
  const total = people.reduce((s, c) => s + c.commits, 0);
  let absence = 0;
  for (let sum = 0; absence < people.length && sum < total / 2; absence++) sum += people[absence].commits;
  if (f.owner) {
    const age = daysSince(f.owner.createdAt, now);
    const org = f.owner.type === "Organization";
    add({
      id: "control.owner",
      section: "control",
      level: "neutral",
      title: org ? (f.owner.verified ? "Verified organization" : "Organization") : "Personal account",
      text: `Owned by ${org ? "the organization" : "the personal account"} ${f.owner.name ? `${f.owner.name} (@${f.owner.login})` : `@${f.owner.login}`}${f.owner.verified ? ", with a domain verified by GitHub" : ""}${age !== null ? `, on GitHub for ${span(age)}` : ""}${!org && f.owner.company ? ` (works at ${f.owner.company})` : ""}.`,
      evidence: [{ label: `@${f.owner.login}`, url: `https://github.com/${f.owner.login}` }],
    });
  }
  const foundation = /\b(Apache Software Foundation|Cloud Native Computing Foundation|CNCF|Linux Foundation|Eclipse Foundation|OpenJS Foundation|Python Software Foundation|NumFOCUS|Software Freedom Conservancy|OpenSSF|Open Source Initiative|\.NET Foundation|Rust Foundation)\b/.exec(readme);
  if (foundation) add({ id: "control.foundation", section: "control", level: "good", title: "Foundation", text: `The README mentions the ${foundation[0]}, so its governance doesn't depend on one company or person.` });
  if (people.length) {
    const top = people[0];
    const share = Math.round((top.commits / total) * 100);
    const sig = size !== "small";
    const recentCommits = (f.recentCommits ?? []).filter((c) => c.login && !/\[bot\]$/.test(c.login));
    const recentShare = recentCommits.length >= 20 ? Math.round((recentCommits.filter((c) => c.login === top.login).length / recentCommits.length) * 100) : null;
    const org = f.owner?.type === "Organization";
    const strong = sig && !org && share >= 80 && (recentShare === null || recentShare >= 80);
    add({
      id: "control.absence",
      section: "control",
      // Contribution concentration is context, not a reason to look first. It matters most when one person on a
      // personal account still writes nearly everything today: then it's the one strong signal.
      level: strong ? "risk" : absence <= 1 ? "note" : absence === 2 ? "neutral" : absence >= 5 ? "good" : "neutral",
      title: absence <= 1 ? (strong ? "One person does nearly all the work" : "Most commits from one person") : `${absence} people wrote half the commits`,
      text:
        absence <= 1
          ? `@${top.login} wrote ${share}% of the commits GitHub counts${recentShare !== null ? ` and ${recentShare}% of the latest ${recentCommits.length}` : ""}${org ? `, in a project owned by an organization` : ""}. That's contribution concentration: it may increase continuity risk if they step away, but commit counts don't show who reviews, releases or decides.`
          : `Half of all commits come from ${absence} people (@${people.slice(0, Math.min(absence, 3)).map((p) => p.login).join(", @")}${absence > 3 ? " and others" : ""}).`,
      evidence: [{ label: "Contributors", url: `${url}/graphs/contributors` }],
      action: absence <= 1 ? (f.releases?.length ? "Pin a release you've tested, so a quiet spell doesn't affect you." : "Note the commit you use; there are no releases to pin.") : undefined,
      weight: sig ? 1.5 : 0.5,
    });
  }
  if (f.repo.fork && f.repo.parent)
    add({ id: "control.fork", section: "control", level: "note", title: "A fork", text: `This repo is a fork of ${f.repo.parent}; the original may be the better one to follow.`, evidence: [{ label: f.repo.parent, url: `https://github.com/${f.repo.parent}` }] });
  if (extra.requested && extra.requested.split("/")[0].toLowerCase() !== f.repo.fullName.split("/")[0].toLowerCase())
    add({ id: "control.moved", section: "control", level: "note", title: "Moved to a new owner", text: `${extra.requested} now leads to ${f.repo.fullName}: the repo was transferred or its owner renamed.` });

  // Recent changes in control: someone new doing most of the work, or new people publishing releases. Normal in
  // healthy projects, and also the pattern behind the 2024 xz backdoor, so it's stated, never judged.
  const ageDays = daysSince(f.repo.createdAt, now) ?? 0;
  const recent = (f.recentCommits ?? []).filter((c) => c.login && !/\[bot\]$/.test(c.login));
  if (recent.length >= 40 && ageDays > 2 * 365) {
    const counts = new Map<string, number>();
    for (const c of recent) counts.set(c.login!, (counts.get(c.login!) ?? 0) + 1);
    const spanDays = (Date.parse(recent[0].date) - Date.parse(recent[recent.length - 1].date)) / DAY;
    for (const [login, n] of counts) {
      const allTime = people.find((p) => p.login === login)?.commits ?? n;
      if (n / recent.length >= 0.25 && allTime <= n * 1.5 && login.toLowerCase() !== f.owner?.login.toLowerCase())
        add({
          id: "control.newcomer",
          section: "control",
          level: "note",
          title: "New main contributor",
          text: `@${login} wrote ${n} of the last ${recent.length} commits (over ${span(spanDays)}) but few before that. New people taking over is often good news; it's also how the 2024 xz attack began, so it's worth knowing.`,
          evidence: [{ label: `@${login}'s commits`, url: `${url}/commits?author=${login}` }],
        });
    }
  }
  const rel = (f.releases ?? []).filter((r) => r.author && !/\[bot\]$/.test(r.author));
  if (rel.length >= 4) {
    const latest = rel[0].author!;
    const before = rel.slice(1).filter((r) => daysSince(r.date, now)! > 180);
    if (before.length >= 3 && !before.some((r) => r.author === latest) && daysSince(rel[0].date, now)! < 180)
      add({ id: "control.releaser", section: "control", level: "note", title: "New release publisher", text: `The latest release (${rel[0].tag}) was published by @${latest}, who hadn't published releases before ${when(before[0].date)}.` });
  }

  // Alive?
  const head = recent[0]?.date ?? f.repo.pushedAt;
  const quiet = daysSince(head, now) ?? 0;
  // A notice near the top, in a sentence: not a "### Deprecated" heading or a list of deprecated options (yt-dlp).
  const readmeTop = readme.replace(/<!--[\s\S]*?-->/g, "").slice(0, 2500).split("\n").filter((l) => !/^\s*(#|\||[-*+] |\d+\.)/.test(l)).join("\n");
  const notice = /\b((this|the) (project|repo(sitory)?|library|tool|package|app) (is|has been) (now )?(no longer|not) (actively )?maintained|(is|are) no longer maintained|(this|the) (project|repo(sitory)?|library|tool|package|app) is (now )?(unmaintained|deprecated)|looking for (new )?maintainers|seeking (new )?maintainers|(this|the) project (has been|is) (archived|abandoned|discontinued))\b/i.exec(readmeTop);
  // Moved to another host (BookStack to Codeberg): GitHub's issues and stats here describe the old copy.
  const movedRe = /\b(moved|migrated|relocated|now (hosted|managed|developed|maintained|lives?))\s+(to|on|at|over to)\s+(codeberg|gitlab|sourcehut|sr\.ht|gitea|forgejo|bitbucket|a new home)/i;
  const moved = movedRe.exec(f.repo.description ?? "") ?? movedRe.exec(readmeTop);
  if (moved)
    add({ id: "activity.moved", section: "activity", level: "risk", title: "Development moved elsewhere", text: `${movedRe.test(f.repo.description ?? "") ? "Its description" : "Its README"} says it has ${moved[0].toLowerCase()}. Issues, releases and activity on GitHub may be out of date; check the new home before relying on this copy.`, weight: 2 });
  if (f.repo.archived)
    add({ id: "activity.archived", section: "activity", level: "risk", title: "Archived", text: moved ? "The owners archived this copy; it's read-only here, and work continues where it moved." : "The owners archived it: it's read-only, with no fixes or updates coming.", weight: moved ? 1 : 3 });
  else if (notice)
    add({ id: "activity.notice", section: "activity", level: "risk", title: "Maintenance notice", text: `The README says: "${notice[0]}".`, evidence: [{ label: "README", url }], weight: 2 });
  if (!f.repo.archived && !moved) add({
    id: "activity.last",
    section: "activity",
    level: quiet > 365 ? "risk" : quiet > 180 ? "note" : "good",
    title: quiet > 365 ? "No recent changes" : quiet > 180 ? "Slowing down" : "Active",
    text: `Last change ${quiet < 1 ? "today" : `${span(quiet)} ago`}.`,
    weight: 1.5,
  });
  if (f.weeks?.length === 52) {
    const year = f.weeks.reduce((a, b) => a + b, 0);
    const recentHalf = f.weeks.slice(26).reduce((a, b) => a + b, 0);
    const earlier = year - recentHalf;
    const activeWeeks = f.weeks.filter((w) => w > 0).length;
    const drop = earlier >= 20 && recentHalf < earlier * 0.4;
    const rise = recentHalf >= 20 && recentHalf > earlier * 1.6;
    add({
      id: "activity.trend",
      section: "activity",
      level: drop ? "note" : year === 0 ? "risk" : "neutral",
      title: drop ? "Activity dropping" : rise ? "Activity growing" : `${plural(year, "commit")} this year`,
      weight: drop ? 2 : 1,
      text: `${plural(year, "commit")} in the last 12 months, with work in ${activeWeeks} of 52 weeks; ${plural(recentHalf, "commit")} in the last 6 months vs ${earlier} in the 6 before${drop ? " (down by more than half)" : rise ? " (growing)" : ""}.`,
    });
  }

  // Releases.
  const stable = (f.releases ?? []).filter((r) => !r.prerelease);
  if (f.releases && !f.releases.length)
    add({ id: "releases.none", section: "releases", level: size === "small" ? "neutral" : "note", title: "No releases", text: "It doesn't publish releases, so there are no fixed versions to install or pin; you'd use whatever the code is today." });
  else if (stable.length) {
    const last = daysSince(stable[0].date, now)!;
    const gaps = stable.slice(0, 10).map((r, i, a) => (i ? (Date.parse(a[i - 1].date) - Date.parse(r.date)) / DAY : null)).filter((x): x is number => x !== null);
    const every = median(gaps);
    // How recent the last release is decides the result; the pace before it is history, with its dates shown, since
    // one burst of quick releases can make it look busier than it is.
    const window = stable.slice(0, 10);
    add({
      id: "releases.cadence",
      section: "releases",
      level: last > 180 ? "note" : "good",
      title: last <= 180 ? "Recent release" : last > 540 ? "No recent release" : `No release in ${span(last)}`,
      text: `Latest release ${stable[0].tag}, ${span(last)} ago.${every !== null && window.length > 2 ? ` Its last ${window.length} releases, from ${when(window.at(-1)!.date)} to ${when(window[0].date)}, came a median of ${span(every)} apart.` : ""}`,
      weight: last > 270 ? 1.5 : 1,
      evidence: [{ label: "Releases", url: `${url}/releases` }],
    });
    const assets = stable.slice(0, 3).flatMap((r) => r.assets);
    if (assets.length) {
      const signed = assets.some((a) => /\.(sig|asc|sigstore(\.json)?|intoto\.jsonl|pem|bundle)$|provenance|attestation/i.test(a));
      const sums = assets.some((a) => /(sha256|sha512|checksums?|sums)/i.test(a)) || stable.slice(0, 3).some((r) => r.sums);
      add({
        id: "releases.signed",
        section: "supply",
        level: signed ? "good" : sums ? "neutral" : "note",
        title: signed ? "Signed releases" : sums ? "Checksums only" : "Unverifiable downloads",
        text: signed
          ? "Release files come with signatures or provenance, so you can check they were built by the project."
          : sums
            ? "Release files come with checksums, which catch broken downloads but not a compromised release (that needs signatures)."
            : "Release files come without checksums or signatures, so there's no way to check a download is the real one.",
      });
    }
  }

  // People.
  if (people.length) {
    const recentPeople = new Set(recent.map((c) => c.login)).size;
    const count = Math.max(f.contributorCount ?? 0, people.length);
    add({
      id: "people.count",
      section: "people",
      level: "neutral",
      title: plural(count, "contributor"),
      text: `${count.toLocaleString("en-US")} ${count === 1 ? "person has" : "people have"} committed to it${f.contributorCount ? " (GitHub's count, including commits not linked to an account)" : ""}${recent.length ? `; ${recentPeople} of them wrote the latest ${recent.length} commits` : ""}.`,
    });
  }

  // Who answers issues: maintainers, other users, or no one. Bots and the author's own comments don't count. Old
  // saved facts have no maintainerReply; they count as no maintainer reply until the next refresh.
  const replyDays = (t: Thread) => (t.firstReply ? (Date.parse(t.firstReply.at) - Date.parse(t.createdAt)) / DAY : null);
  if (!f.repo.hasIssues)
    add({ id: "responsiveness.closed", section: "responsiveness", level: "note", title: "Issues turned off", text: "There's no public issue tracker, so problems can't be reported or looked up on GitHub." });
  else if (f.threads) {
    const issues = f.threads.issues.filter((t) => !t.bot && daysSince(t.createdAt, now)! >= 2);
    if (issues.length >= 5) {
      const times = issues.map(replyDays).filter((x): x is number => x !== null);
      const older = issues.filter((t) => daysSince(t.createdAt, now)! >= 7);
      const silent = older.filter((t) => !t.firstReply && !t.closedAt).length;
      const m = median(times);
      const silentShare = older.length ? silent / older.length : 0;
      const maint = issues.filter((t) => t.maintainerReply).length;
      const botOnly = issues.filter((t) => t.botReply && !t.firstReply).length;
      const oldest = issues.reduce((a, t) => (t.createdAt < a ? t.createdAt : a), issues[0].createdAt);
      add({
        id: "responsiveness.issues",
        section: "responsiveness",
        level: silentShare > 0.5 || (m !== null && m > 30) ? "risk" : m === null || m > 7 || silentShare > 0.25 || times.length < issues.length / 3 ? "note" : "good",
        // The title states the problem when there is one: "Someone replies in 14 hours" read as good news while
        // most issues got no answer.
        title: silentShare > 0.25 ? `${Math.round(silentShare * 100)}% of issues get no reply` : m === null ? "Few replies" : m > 7 ? `Replies take ${span(m)}` : `Someone replies in ${span(m)}`,
        text: `Of its ${issues.length} latest issues (opened since ${when(oldest)}), ${times.length} got a reply from someone other than the author${m !== null ? `, typically within ${span(m)}` : ""}: ${maint} from a maintainer (owner, member or collaborator)${times.length - maint ? `, ${times.length - maint} only from other users` : ""}${botOnly ? `; ${botOnly} only from bots, not counted` : ""}${older.length ? `. ${silent} of ${older.length} older than a week (${Math.round(silentShare * 100)}%) have no reply and are still open` : ""}.`,
        evidence: [{ label: "Issues", url: `${url}/issues` }],
        weight: 1.5,
      });
      // Maintainers apart from everyone else: replies from other users are help, not support.
      if (issues.some((t) => t.maintainerReply !== undefined)) {
        const share = maint / issues.length;
        add({
          id: "responsiveness.maintainers",
          section: "responsiveness",
          level: share >= 0.5 ? "good" : share >= 0.2 ? "neutral" : "note",
          title: maint ? `Maintainers answered ${maint} of ${issues.length} issues` : "No maintainer replies seen",
          text: `A maintainer (owner, member or collaborator) replied on ${maint} of the ${issues.length} latest issues${maint ? "" : "; any replies came from other users"}. People can be maintainers without GitHub showing it, so this can undercount.`,
          evidence: [{ label: "Issues", url: `${url}/issues` }],
        });
      }
    }
    const prs = f.threads.prs.filter((t) => !t.bot && daysSince(t.createdAt, now)! >= 7);
    if (prs.length >= 5) {
      const merged = prs.filter((p) => p.mergedAt);
      const toMerge = median(merged.map((p) => (Date.parse(p.mergedAt!) - Date.parse(p.createdAt)) / DAY));
      const waiting = prs.filter((p) => !p.closedAt && !p.firstReply).length;
      add({
        id: "responsiveness.prs",
        section: "responsiveness",
        level: waiting / prs.length > 0.5 || !merged.length ? "note" : "neutral",
        title: `${merged.length} of ${prs.length} changes merged`,
        text: `Of the ${prs.length} latest outside changes (pull requests), ${merged.length} were merged${toMerge !== null ? `, typically in ${span(toMerge)}` : ""}; ${waiting} are waiting without any review.`,
        evidence: [{ label: "Pull requests", url: `${url}/pulls` }],
      });
    }
  }

  // Community health files.
  const c = f.community?.files ?? {};
  const security = has(/^(\.github\/|docs\/)?SECURITY(\.md|\.txt|\.rst)?$/i);
  add({
    id: "community.security",
    section: "security",
    level: security ? "good" : size === "small" ? "neutral" : "note",
    title: security ? "Security policy" : "No security policy",
    text: security ? "It says how to report a security problem privately." : "There's no SECURITY.md, so it's unclear how to report a vulnerability without making it public.",
    weight: size === "large" ? 1.5 : 1,
  });
  const extras = [c.contributing && "contributing guide", c.code_of_conduct && "code of conduct", (c.issue_template || has(/^\.github\/ISSUE_TEMPLATE\//)) && "issue templates", has(/^(\.github\/)?CODEOWNERS$/) && "code owners"].filter(Boolean) as string[];
  if (extras.length || size !== "small")
    add({
      id: "community.files",
      section: "community",
      level: extras.length >= 3 ? "good" : extras.length ? "neutral" : "note",
      title: extras.length ? `${extras.length} community files` : "No community files",
      text: extras.length ? `Has a ${extras.join(", ")}.` : "No contributing guide, code of conduct or issue templates.",
    });
  const funded = (f.funding?.length ?? 0) > 0 || has(/^\.github\/FUNDING\.ya?ml$/i);
  if (funded)
    add({ id: "community.funding", section: "community", level: "good", title: "Takes sponsorship", text: `People can fund it${f.funding?.length ? ` (${[...new Set(f.funding.map((x) => x.platform.toLowerCase().replace(/_/g, " ")))].join(", ")})` : ""}, which helps maintainers keep going.` });

  // Security.
  const adv = f.advisories ?? [];
  if (f.advisories) {
    const serious = adv.filter((a) => /critical|high/i.test(a.severity));
    const lastYear = adv.filter((a) => daysSince(a.published, now)! < 365);
    add({
      id: "security.advisories",
      section: "security",
      level: adv.length ? "neutral" : "neutral",
      title: adv.length ? plural(adv.length, "security advisory", "security advisories") : "No published advisories",
      text: adv.length
        ? `It has published ${plural(adv.length, "security advisory", "security advisories")}${serious.length ? ` (${serious.length} high or critical)` : ""}, ${lastYear.length} in the last year. Publishing them shows problems get disclosed; check each one for the versions affected and the version that fixes it.`
        : "It hasn't published any security advisories on GitHub. That can mean few problems, or that they're handled elsewhere.",
      evidence: adv.length ? [{ label: "Advisories", url: `${url}/security/advisories` }] : undefined,
    });
  }
  if (f.scorecard) {
    const s = f.scorecard.score;
    const zero = (name: string) => f.scorecard!.checks.find((x) => x.name === name && x.score === 0);
    add({
      id: "security.scorecard",
      section: "security",
      level: s >= 7 ? "good" : s >= 4 ? "neutral" : "note",
      title: `OpenSSF Scorecard ${s.toFixed(1)}/10`,
      text: `OpenSSF's automated security checks score it ${s.toFixed(1)} out of 10 (as of ${when(f.scorecard.date)}).`,
      evidence: [{ label: "Scorecard", url: `https://scorecard.dev/viewer/?uri=github.com/${f.repo.fullName}` }],
      weight: 1.5,
    });
    const dangerous = zero("Dangerous-Workflow");
    if (dangerous) add({ id: "security.workflow", section: "supply", level: "risk", title: "Risky automation", text: `Scorecard found a dangerous GitHub Actions pattern: ${dangerous.reason}.`, weight: 2 });
  }

  // Dependencies.
  if (f.deps) {
    const v = f.deps.vulnerable;
    const serious = v.filter((x) => /critical|high/i.test(x.severity ?? ""));
    add({
      id: "deps.vulns",
      section: "dependencies",
      level: !v.length ? "good" : v.some((x) => /critical/i.test(x.severity ?? "")) || serious.length >= 5 ? "risk" : "note",
      title: v.length ? `${plural(v.length, "dependency", "dependencies")} with known flaws` : f.deps.checked ? `No known flaws in ${plural(f.deps.checked, "scanned dependency", "scanned dependencies")}` : "No dependencies to scan",
      text: v.length
        ? `${plural(v.length, "package")} it depends on (out of ${f.deps.checked.toLocaleString("en-US")} checked${f.deps.checked >= 1000 ? ", the most checked, so the result is partial" : ""}) ${v.length === 1 ? "has" : "have"} known vulnerabilities in OSV.dev${serious.length ? `; ${serious.length} of those packages have one rated high or critical` : ""}. Whether each reaches what you run, and which version fixes it, wasn't checked.`
        : f.deps.checked
          ? `${f.deps.checked === 1 ? "The one package GitHub lists with an exact version has" : `None of the ${f.deps.checked.toLocaleString("en-US")} packages GitHub lists with exact versions have`} known vulnerabilities in OSV.dev. That covers known flaws in those dependencies only, not the project's own code or packages GitHub doesn't list.`
          : "GitHub lists no dependencies with exact versions to check.",
      evidence: [{ label: "Dependencies", url: `${url}/network/dependencies` }],
      action: v.length ? `Check whether the affected packages reach what you run and update them (${audit(f.paths)}). Development tools still run in builds and CI, so they matter there.` : undefined,
    });
    // Ranges in a manifest only mean changing installs when there's no lock file; with one, they just weren't checkable.
    const lock = f.paths.filter((p) => LOCKFILE.test(p) && !/(^|\/)(node_modules|vendor)\//.test(p)).sort((a, b) => a.split("/").length - b.split("/").length)[0]; // the root one first
    const ranged = f.deps.total - f.deps.checked;
    if (ranged > 20)
      add({
        id: "deps.unpinned",
        section: "dependencies",
        level: "neutral",
        title: lock ? "Some versions not checked" : "Some versions not fixed",
        text: lock
          ? `${ranged.toLocaleString("en-US")} of its ${f.deps.total.toLocaleString("en-US")} dependencies are listed without an exact version${f.deps.checked >= 1000 ? " or past the 1,000 checked" : ""}, so they weren't checked for known flaws. Installs from ${lock} get the versions it fixes.`
          : `${ranged.toLocaleString("en-US")} of its ${f.deps.total.toLocaleString("en-US")} dependencies are listed as version ranges and no lock file was found, so which version you get can change from one install to the next.`,
      });
  }

  // Can you trust what you download?
  const pipe = /(curl|wget)[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|(iwr|irm|Invoke-WebRequest|Invoke-RestMethod)[^\n|]{0,200}\|\s*iex/i.exec(readme);
  if (pipe)
    add({ id: "supply.pipe", section: "supply", level: "note", title: "Install script piped to a shell", text: "The README installs by downloading a script and running it straight away. It's common, but you're trusting the script without seeing it; read it first." });
  const pkg = Object.entries(f.texts).find(([p]) => p === "package.json")?.[1];
  // Only a published package's hooks run on your machine when you install it; a private root's run for contributors.
  const isPrivate = /"private"\s*:\s*true/.test(pkg ?? "");
  const hooks = pkg && !isPrivate ? /"(preinstall|install|postinstall)"\s*:\s*"([^"]+)"/.exec(pkg) : null;
  if (hooks)
    add({ id: "supply.hooks", section: "supply", level: "note", title: "Runs code on install", text: `Its package.json runs a "${hooks[1]}" script (${hooks[2].slice(0, 80)}) whenever it's installed.` });
  // Real binaries only: a dotfile like ".package.deb" is a placeholder (Navidrome), not a compiled file.
  const bins = f.paths.filter((p) => /\.(exe|dll|so|dylib|jar|msi|apk|dmg|deb|rpm|bin|pyd)$/i.test(p) && !/(^|\/)\.[^/]+$/.test(p) && !/(^|\/)(tests?|testdata|fixtures?|examples?|vendor)\//i.test(p));
  if (bins.length)
    add({ id: "supply.binaries", section: "supply", level: "note", title: "Compiled files in the code", text: `${plural(bins.length, "compiled file")} (${bins.slice(0, 2).join(", ")}${bins.length > 2 ? "…" : ""}) ${bins.length === 1 ? "is" : "are"} stored in the repo, which can't be reviewed like source code.` });
  if (has(/^\.gitmodules$/))
    add({ id: "supply.submodules", section: "supply", level: "neutral", title: "Uses submodules", text: "Part of the code comes from other repositories (git submodules), which have their own owners." });
  const uses = workflows.flatMap(([, t]) => [...t.matchAll(/uses:\s*['"]?([\w.-]+\/[\w./-]+)@([\w.-]+)/g)]).filter((m) => !m[1].startsWith("./") && !/^actions\//.test(m[1]) && !/^github\//.test(m[1]));
  if (uses.length >= 3) {
    const pinned = uses.filter((m) => /^[0-9a-f]{40}$/.test(m[2])).length;
    if (pinned / uses.length < 0.5)
      add({ id: "supply.actions", section: "supply", level: "neutral", title: "Third-party automation not pinned", text: `${uses.length - pinned} of ${uses.length} third-party GitHub Actions it runs are referenced by a tag rather than a fixed commit, so a change upstream reaches its builds automatically.` });
  }

  // Does it send data anywhere?
  const SDKS: [RegExp, string][] = [
    [/posthog/i, "PostHog"], [/@segment\/|analytics-node|segment-analytics/i, "Segment"], [/mixpanel/i, "Mixpanel"], [/amplitude/i, "Amplitude"],
    [/@sentry\/|sentry-sdk|sentry_sdk|"sentry"|getsentry/i, "Sentry"], [/bugsnag/i, "Bugsnag"], [/rollbar/i, "Rollbar"], [/dd-trace|datadog/i, "Datadog"],
    [/newrelic/i, "New Relic"], [/rudderstack|rudder-sdk/i, "RudderStack"], [/@scarf\/scarf|scarf-js/i, "Scarf"], [/heap-api|heapanalytics/i, "Heap"],
  ];
  const own = f.repo.fullName.toLowerCase();
  // Only what ships: Sentry in FastAPI's test dependencies doesn't send your data anywhere.
  const runtimeManifests = Object.entries(f.texts)
    .filter(([p]) => /(^|\/)(package\.json|pyproject\.toml|setup\.py|setup\.cfg|requirements\.txt|Cargo\.toml|go\.mod|Gemfile|composer\.json|pom\.xml|build\.gradle)/i.test(p))
    .map(([p, t]) => {
      if (/package\.json$|composer\.json$/.test(p))
        try {
          const j = JSON.parse(t) as Record<string, Record<string, string> | undefined>;
          return Object.keys({ ...j.dependencies, ...j.optionalDependencies, ...j.require }).join("\n");
        } catch {
          return t;
        }
      if (/pyproject\.toml$/.test(p)) return /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(t)?.[1] ?? "";
      if (/Cargo\.toml$/.test(p)) return t.replace(/^\[(dev|build)-dependencies\][\s\S]*?(?=^\[|(?![\s\S]))/gm, "");
      return t;
    })
    .join("\n");
  const sdks = SDKS.filter(([re, n]) => re.test(runtimeManifests) && !own.includes(n.toLowerCase().replace(/\s/g, ""))).map(([, n]) => n);
  const mention = /\b(telemetry|anonymous (usage|statistics|data)|usage (data|statistics|analytics)|phone[- ]home|collects? (anonymous )?(usage|analytics))\b/i.exec(docs);
  const optOut = /\b(opt[- ]?out|DO_NOT_TRACK|disable (the )?telemetry|TELEMETRY_(ENABLED|DISABLED)|ANONYMIZED_TELEMETRY|turn off (telemetry|analytics))\b/i.test(docs);
  const optIn = /\bopt[- ]?in\b/i.test(docs);
  // The actual setting, when the docs name one: an environment variable or flag, not just the words "opt out".
  const off = /\b(DO_NOT_TRACK=\S+|[A-Z][A-Z0-9_]*TELEMETRY[A-Z0-9_]*(=\S+)?|[A-Z][A-Z0-9_]*(ANALYTICS|TRACKING)[A-Z0-9_]*=\S+|--(no-|disable-)(telemetry|analytics)\b)/.exec(docs);
  if (mention)
    add({
      id: "privacy.telemetry",
      section: "privacy",
      level: optIn && !optOut ? "neutral" : "note",
      title: optIn && !optOut ? "Telemetry, opt-in" : optOut ? "Telemetry, on by default" : "Telemetry mentioned",
      action: optIn && !optOut ? undefined : off
        ? `Its docs name a way to turn it off ("${off[0]}"); check what it covers before relying on it.`
        : "How to turn it off wasn't found in the files read; check its docs or ask the maintainers before running it where that matters.",
      text: optIn && !optOut
        ? "Its docs describe usage data that's only collected if you turn it on."
        : optOut
          ? "Its docs describe usage data it collects, with a way to turn it off. Check what's sent and switch it off if you prefer."
          : `Its docs mention collecting data ("${mention[0]}"). Read how it works before running it.`,
    });
  if (sdks.length)
    add({ id: "privacy.sdks", section: "privacy", level: "note", title: "Analytics or crash reporting", text: `Its dependencies include ${sdks.join(", ")}, services that receive usage or error data when they're set up.` });
  if (!mention && !sdks.length)
    add({ id: "privacy.none", section: "privacy", level: "neutral", title: "No telemetry found", text: "The files read don't mention telemetry or include analytics or crash-reporting libraries. This covers usage tracking only: what it sends to services you connect (AI providers, APIs, storage) wasn't checked, and nothing was run to watch its network traffic." });

  // Adoption signals. Stars can be bought, and a star check needs access GitHub doesn't give us, so these are only stated.
  const dl = (f.packages ?? []).filter((p) => p.downloadsMonth !== null);
  const dependents = (f.packages ?? []).reduce((s, p) => s + (p.dependents ?? 0), 0);
  add({
    id: "popularity.numbers",
    section: "popularity",
    level: "neutral",
    title: `${f.repo.stars.toLocaleString("en-US")} stars`,
    text: `${plural(f.repo.stars, "star")}, ${plural(f.repo.forks, "fork")} and ${plural(f.repo.watchers, "watcher")}${dl.length ? `; ${dl.map((p) => `${p.name} is downloaded about ${p.downloadsMonth!.toLocaleString("en-US")} times a month (${p.system.toLowerCase()})`).join("; ")}` : ""}${dependents ? `; ${plural(dependents, "package")} depend on it` : ""}. These show interest, not how many people use it: installs through git, plugin stores or other channels aren't counted${dl.length ? ", and only packages its own files name are included" : ""}.`,
  });
  const fork = (f.forksTop ?? [])[0];
  if (fork && quiet > 365 && daysSince(fork.pushedAt, now)! < 120 && fork.stars >= Math.max(20, f.repo.stars * 0.02))
    add({ id: "popularity.fork", section: "popularity", level: "note", title: "Active fork", text: `It's been quiet for ${span(quiet)}, while the fork ${fork.name} (${plural(fork.stars, "star")}) was updated ${span(daysSince(fork.pushedAt, now)!)} ago and may be where work continues.`, evidence: [{ label: fork.name, url: `https://github.com/${fork.name}` }] });

  // What it costs to run.
  if (extra.paidAi?.length)
    add({
      id: "cost.ai",
      section: "cost",
      level: "note",
      title: "Paid AI services",
      text: `It can use ${extra.paidAi.length < 3 ? extra.paidAi.join(" or ") : `${extra.paidAi.slice(0, -1).join(", ")} or ${extra.paidAi.at(-1)}`}, which bill per use; its README says whether one is required.`,
    });
  const gpu = /\b(NVIDIA GPU|CUDA|VRAM|requires? (a )?GPU|GPU (is )?(required|recommended)|Apple Silicon|Metal)\b/i.exec(readme);
  if (gpu) add({ id: "cost.gpu", section: "cost", level: "neutral", title: "Hardware", text: `The README mentions "${gpu[0]}": it may need, or run much faster on, a capable graphics card.` });
  const cloud = Object.entries(f.texts)
    .filter(([p]) => /env/i.test(p))
    .flatMap(([, t]) => [...t.matchAll(/^(AWS_|STRIPE_|SUPABASE_|FIREBASE_|TWILIO_|SENDGRID_|RESEND_|PINECONE_|CLOUDFLARE_|VERCEL_)/gm)].map((m) => m[1]));
  if (cloud.length) {
    const names = [...new Set(cloud.map((p) => ({ AWS_: "AWS", STRIPE_: "Stripe", SUPABASE_: "Supabase", FIREBASE_: "Firebase", TWILIO_: "Twilio", SENDGRID_: "SendGrid", RESEND_: "Resend", PINECONE_: "Pinecone", CLOUDFLARE_: "Cloudflare", VERCEL_: "Vercel" })[p as "AWS_"]))];
    add({ id: "cost.services", section: "cost", level: "neutral", title: "Outside services", text: `Its settings have keys for ${names.join(", ")}: accounts you may need, some of them paid.` });
  }

  return out;
}

// ── Every finding, filled in ─────────────────────────────────────────────────────────────────────────────────────
// Rules set what they know; the rest follows from the level: a status, how it's known, how much it matters and,
// for the common concerns, what to do about it.
const STATUS: Record<Level, Status> = { good: "pass", note: "concern", risk: "concern", neutral: "info" };
const REPORTED = new Set<SectionId>(["activity", "releases", "people", "responsiveness", "security", "popularity", "dependencies", "control"]);
const DOCUMENTED = new Set(["activity.notice", "license.model", "license.paid", "control.foundation", "cost.gpu", "privacy.telemetry", "cost.ai"]);
const ACTIONS: Record<string, string> = {
  "license.none": "Ask the owner to add a license before using it in anything you share or sell.",
  "license.kind": "Read the license terms for your use; a business may need a commercial license or legal review.",
  "license.changed": "Check which license covers the version you use; earlier releases keep their earlier license.",
  "license.opencore": "Check whether the features you need are in the open part or the paid one.",
  "activity.archived": "Look for an active fork or an alternative before depending on it.",
  "activity.moved": "Follow the link to where it moved and inspect that copy's activity and releases.",
  "activity.notice": "Look for an active fork or an alternative before depending on it.",
  "activity.last": "Check open issues for whether it still works with current versions of what it depends on.",
  "control.absence": "Pin a version you've tested, and have a plan if the main maintainer steps away.",
  "control.newcomer": "Look over the newcomer's recent changes and releases before upgrading.",
  "community.security": "If you find a security problem, contact the maintainers privately before posting it.",
  "responsiveness.issues": "Don't count on quick help through issues; search closed issues first.",
  "releases.signed": "Compare downloads against a source you trust, or build from source.",
  "supply.pipe": "Download the install script and read it before running it.",
  "supply.hooks": "Read the install script before installing. Installing with --ignore-scripts skips it, but may also skip build or setup steps the project needs.",
  "privacy.sdks": "Check whether these are switched on by default in its configuration.",
  "security.workflow": "Treat its release builds with care until the workflow is fixed.",
};
export function finish(x: Finding): Finding {
  const status = x.status ?? STATUS[x.level];
  return {
    ...x,
    status,
    kind: x.kind ?? (x.id.startsWith("ai.") ? "inferred" : DOCUMENTED.has(x.id) ? "documented" : REPORTED.has(x.section) ? "reported" : ("detected" as EvidenceKind)),
    priority: status === "concern" || status === "not-found" ? (x.priority ?? (x.level === "risk" ? "important" : x.level === "note" ? "improvement" : undefined)) : undefined,
    action: x.action ?? (x.level === "risk" || x.level === "note" ? ACTIONS[x.id] : undefined),
    // The same place twice (two settings read on one line) is one link.
    evidence: x.evidence?.filter((e, i, all) => all.findIndex((o) => (o.url ?? o.label) === (e.url ?? e.label)) === i),
  };
}

// ── The 12 headline answers ──────────────────────────────────────────────────────────────────────────────────────
const RANK: Record<Level, number> = { risk: 3, note: 2, good: 1, neutral: 0 };
const MAP: Record<HeadlineId, string[]> = {
  open: ["license.none", "license.kind", "license.model"],
  obligations: ["license.obligations"],
  control: ["control.owner", "control.foundation", "control.absence", "control.fork"],
  changes: ["control.newcomer", "control.releaser", "control.moved", "license.changed"],
  free: ["license.opencore", "license.scope", "license.paid", "license.cla", "license.dco"],
  alive: ["activity.moved", "activity.archived", "activity.notice", "activity.last", "activity.trend", "releases.cadence", "releases.none"],
  responds: ["responsiveness.closed", "responsiveness.maintainers", "responsiveness.issues", "responsiveness.prs"],
  vulns: ["security.advisories", "deps.vulns"],
  trust: ["releases.signed", "supply.pipe", "supply.hooks", "supply.binaries", "security.workflow", "secrets.found"],
  data: ["privacy.telemetry", "privacy.sdks", "privacy.none"],
  popularity: ["popularity.numbers", "popularity.fork"],
  cost: ["cost.ai", "cost.gpu", "cost.services", "services.accounts"],
};

export function headline(all: Finding[]): Answer[] {
  const out: Answer[] = [];
  for (const h of HEADLINE) {
    const hits = [...MAP[h.id].map((id) => all.filter((x) => x.id === id)).flat(), ...all.filter((x) => x.headline === h.id && !MAP[h.id].includes(x.id))];
    if (!hits.length) {
      if (h.id === "changes") out.push({ id: h.id, level: "neutral", verdict: "Nothing unusual seen", text: "In the latest 100 commits, recent releases and the license file's history: no new main contributor, new release publisher, transfer or license change. Who can publish its packages or change settings isn't visible from outside.", findings: [] });
      if (h.id === "cost") out.push({ id: h.id, level: "neutral", verdict: "No extra costs found", text: "The files read name no paid APIs, accounts, outside services or special hardware beyond what it runs on. Hosting, and any AI or API usage you add, are separate costs.", findings: [] });
      continue;
    }
    const lead = [...hits].sort((a, b) => RANK[b.level] - RANK[a.level])[0];
    // The strongest finding leads; neutral background only when there's nothing stronger to say.
    const shown = hits.some((x) => x.level !== "neutral") ? [lead, ...hits.filter((x) => x !== lead && x.level !== "neutral")] : hits;
    out.push({ id: h.id, level: lead.level, verdict: lead.title, text: shown.map((x) => x.text).join(" "), findings: hits.map((x) => x.id) });
  }
  return out;
}

// ── Grades ───────────────────────────────────────────────────────────────────────────────────────────────────────
const GRADE_SECTIONS: Record<GradeId, SectionId[]> = {
  maintenance: ["activity", "releases"],
  continuity: ["people", "control"],
  community: ["responsiveness", "community"],
  security: ["security", "dependencies", "supply", "secrets"],
  openness: ["license", "privacy"],
};
const letter = (score: number): Grade => (score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F");

export function grades(all: Finding[]): Grades {
  const parts: Grades["parts"] = {};
  for (const [id, sections] of Object.entries(GRADE_SECTIONS) as [GradeId, SectionId[]][]) {
    const mine = all.filter((x) => sections.includes(x.section) && x.level !== "neutral" && x.status !== "n/a" && x.status !== "not-checked");
    if (!mine.length) continue;
    // Support is graded on replies; community files alone (a contributing guide, templates) don't make it strong.
    if (id === "community" && !mine.some((x) => x.section === "responsiveness")) continue;
    let score = 100;
    for (const x of mine) score -= (x.level === "risk" ? 25 : x.level === "note" ? 10 : 0) * (x.weight ?? 1);
    score = Math.max(0, Math.min(100, Math.round(score)));
    // Small things add up, but only something serious takes a grade below B.
    if (!mine.some((x) => x.level === "risk")) score = Math.max(score, 70);
    const reasons = mine
      .filter((x) => x.level !== "good")
      .sort((a, b) => RANK[b.level] * (b.weight ?? 1) - RANK[a.level] * (a.weight ?? 1))
      .slice(0, 3)
      .map((x) => x.title);
    // held: the reasons are what pulled it down; otherwise they're what earned it.
    parts[id] = { grade: letter(score), score, held: reasons.length > 0, reasons: reasons.length ? reasons : mine.filter((x) => x.level === "good").slice(0, 2).map((x) => x.title) };
  }
  const scores = Object.values(parts).map((p) => p!.score);
  return { overall: scores.length ? letter(scores.reduce((a, b) => a + b, 0) / scores.length) : null, parts };
}

import type { Analysis } from "./detect";
import type { Arch, InstallOptions } from "./install";
import { OS_LABEL, type OS } from "./os";

export type Fit = {
  status: "yes" | "maybe" | "no";
  headline: string;
  reasons: string[];
};

const CPU_LABEL = { arm64: "an arm64 (ARM) processor", x64: "an x86-64 (Intel or AMD) processor" } as const;
const ARCH_LABEL: Record<Arch, string> = { arm64: "arm64 (ARM)", x64: "x86-64 (Intel or AMD)", x86: "32-bit x86", armv7: "32-bit ARM", universal: "any" };

// Answers "will this work on my machine?" from what the analysis already found. arch: the visitor's processor, when
// it's their own system (null otherwise).
export function fitCheck(a: Analysis, install: InstallOptions, os: OS, arch: Arch | null, archived: boolean): Fit {
  const fit = baseFit(a, install, os, arch, archived);
  // The processor it says it needs ("an arm64 Linux host"), for this system (or any). Only explicit requirements get
  // here (lib/hardware.ts cpuNeed), and a confirmed wrong chip is the only "No" it gives.
  const cpu = a.cpu && (!a.cpu.os || a.cpu.os === os) ? a.cpu : null;
  if (!cpu || fit.status === "no") return fit;
  const said = `The project says: “${cpu.quote}”`;
  const fits = !arch || arch === "universal" ? null : cpu.arch === "arm64" ? arch === "arm64" : arch === "x64" || arch === "x86" || (os === "mac" && arch === "arm64"); // Rosetta 2 runs Intel code on Apple Silicon
  if (fits === false)
    return { status: "no", headline: `Needs ${CPU_LABEL[cpu.arch]}`, reasons: [said, `Yours is ${ARCH_LABEL[arch!]}, so it won't run on this computer.`] };
  if (fits === true) return { ...fit, reasons: [...fit.reasons, `It needs ${CPU_LABEL[cpu.arch]}, which yours is.`] };
  // Not known which processor this is: say what it needs, and don't promise more than "maybe".
  return {
    status: "maybe",
    headline: fit.status === "yes" ? `Only on ${cpu.arch === "arm64" ? "arm64 (ARM)" : "x86-64"} computers` : fit.headline,
    reasons: [said, ...fit.reasons],
  };
}

function baseFit(a: Analysis, install: InstallOptions, os: OS, arch: Arch | null, archived: boolean): Fit {
  const name = OS_LABEL[os];
  const reasons: string[] = [];
  const assets = install.release?.assets.filter((x) => x.os === os) ?? [];
  // 32-bit Windows builds run on 64-bit Windows; Intel Mac builds run on Apple Silicon through Rosetta 2.
  const runsOn = (x: Arch | null) =>
    !arch || x === arch || x === "universal" || x === null || (os === "windows" && arch === "x64" && x === "x86") || (os === "mac" && arch === "arm64" && x === "x64");
  const forArch = assets.filter((x) => runsOn(x.arch));
  const native = forArch.some((x) => !arch || x.arch === arch || x.arch === "universal" || x.arch === null);
  const hasSource = a.steps[os].some((s) => /install dependencies|^run\b|start/i.test(s.title));

  if (install.declared?.unsupported.includes(os)) {
    reasons.push(`The project says: “${install.declared.quote}”`);
    if (os !== "linux") reasons.push(`It may run inside a Linux virtual machine${os === "windows" ? " or WSL2" : ""}, but that's not a supported setup.`);
    return { status: "no", headline: `Not supported on ${name}`, reasons };
  }

  // Made for another system: building it yourself won't change what the code is written for.
  const only = install.only;
  if (only && only.os !== os) {
    const other = OS_LABEL[only.os];
    // In plain words, without file paths: "it describes itself as made for Windows, its Rust code uses Windows
    // system libraries, and its releases only have Windows downloads".
    const said = only.signals.map((x) => x.replace(/\s*\([^)]*\)$/, "")).slice(0, 3);
    reasons.push(`It's made for ${other}: ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}.`);
    if (only.sure) {
      reasons.push(`Its code uses ${other.endsWith("s") ? `${other}'` : `${other}'s`} own system features, so building it yourself won't make it run on ${name}.`);
      return { status: "no", headline: `Made for ${other} only`, reasons };
    }
    reasons.push(`Check the README for ${name} support before trying it.`);
    return { status: "maybe", headline: `Probably ${other} only`, reasons };
  }

  if (os !== "mac" && a.hints.some((h) => h.startsWith("Built on Apple's MLX"))) {
    reasons.push("It's built on Apple's MLX, which is made for Apple Silicon Macs. Check the README for Windows or Linux support before installing.");
    return { status: "maybe", headline: `Made for Apple Silicon Macs`, reasons };
  }

  if (archived) reasons.push("The repo is archived: it still works as-is, but nobody is fixing bugs anymore.");

  if (a.needsDevice) {
    reasons.push("The app runs on a separate device (phone, tablet or TV). Your computer only installs it.");
    if (a.compatibility) reasons.push(`The README lists supported devices under “${a.compatibility.heading}”. Find yours there first.`);
    else reasons.push("The README has no device list, so check that your device supports ADB debugging.");
    return { status: "maybe", headline: "Depends on your device", reasons };
  }

  const cmds = install.commands.filter((c) => c.os.includes(os));
  const app = cmds.find((c) => c.kind === "app");
  if (forArch.length || app) {
    reasons.push(forArch.length ? `A ready-made ${name} download is in the latest release.` : readmeInstall(app!.method, name));
    if (forArch.length && !native && !app) {
      reasons.push(os === "mac" ? "The download is built for Intel Macs; it runs on Apple Silicon through Rosetta 2." : "The download is the 32-bit build; it runs fine on 64-bit Windows.");
    }
    return { status: "yes", headline: `Yes, it installs on your ${name}`, reasons };
  }

  // The release has nothing for this system, but the project's own site does (the README links to it).
  if (install.downloadPage?.platforms.includes(os)) {
    reasons.push(`The project's website (${install.downloadPage.host}) has a ready-made ${name} download; the README links to it.`);
    return { status: "yes", headline: `Yes, it installs on your ${name}`, reasons };
  }

  // Nothing to install on this computer, but the release has an Android app: it runs on the phone, not here.
  const apks = install.release?.deviceAssets ?? [];
  if (apks.length && !install.platforms.includes(os)) {
    reasons.push(`It's an Android app: the latest release has a ready-made .apk. Download it on your Android device, or install it from your ${name} with adb.`);
    if (a.compatibility) reasons.push(`The README lists supported devices under “${a.compatibility.heading}”. Find yours there first.`);
    return { status: "yes", headline: "Yes, on your Android device", reasons };
  }

  if (assets.length && arch) {
    reasons.push(`There are ${name} downloads, but none built for your chip. Building from source usually still works.`);
    return { status: "maybe", headline: "Probably, from source", reasons };
  }

  if (install.platforms.length && !install.platforms.includes(os)) {
    reasons.push(`Apps are only published for ${install.platforms.map((p) => OS_LABEL[p]).join(" and ")}.`);
    if (!hasSource) return { status: "no", headline: `No ${name} version`, reasons };
  }

  if (cmds.some((c) => c.kind === "docker")) {
    reasons.push("It's a self-hosted app: the README runs it with Docker, and you open it in your browser.");
    if (os !== "linux") reasons.push(`On ${name} that means installing Docker Desktop first.`);
    return { status: "yes", headline: `Yes, with Docker on ${name}`, reasons };
  }

  const scaffold = cmds.find((c) => c.kind === "scaffold");
  if (scaffold) {
    reasons.push(`It's a framework: you start a new project with it (\`${scaffold.command}\`) instead of installing an app.`);
    return { status: "yes", headline: `Yes, start a project on ${name}`, reasons };
  }

  const lib = cmds.find((c) => c.kind === "library");
  if (lib) {
    reasons.push(`It's a library: you add it to your own project (\`${lib.command}\`), there's no app to open.`);
    return { status: "yes", headline: `Yes, as a library on ${name}`, reasons };
  }

  if (a.osNotes[os].length) {
    reasons.push(...a.osNotes[os]);
    return { status: "maybe", headline: `Yes, with extra tools on ${name}`, reasons };
  }

  if (hasSource || a.runtimes.length) {
    const parts = [...a.runtimes.map((r) => r.name), ...a.tools];
    reasons.push(parts.length ? `You'll build it yourself with ${parts.slice(0, 4).join(", ")}.` : "You'll build it yourself from the source code.");
    if (a.services.length) reasons.push(`It also needs ${a.services.map((s) => s.name).join(", ")} running (Docker handles this).`);
    return { status: "yes", headline: `Yes, it runs on ${name}`, reasons };
  }

  // Made for this very system (it says so, or its code does), with nothing else above to go on: that's still an answer.
  const readmeSteps = a.steps[os].some((s) => s.from === "readme" && s.commands.length);
  if (only?.os === os) {
    const said = only.signals.map((x) => x.replace(/\s*\([^)]*\)$/, "")).slice(0, 3);
    reasons.push(`It's made for ${name}: ${said.length > 1 ? `${said.slice(0, -1).join(", ")} and ${said.at(-1)}` : said[0]}.`);
    reasons.push(readmeSteps ? "Follow the README's steps below, in order." : "There are no setup files we know, so the README below is your guide.");
    // A firm "Yes" only when its code shows it (only.sure) and the README gives the steps; a description alone can be
    // misread (a list of links that mentions macOS), so that stays "Probably".
    if (only.sure && readmeSteps) return { status: "yes", headline: `Yes, it's made for ${name}`, reasons };
    return { status: "maybe", headline: only.sure ? `Made for ${name}: follow its README` : `Probably made for ${name}: follow its README`, reasons };
  }
  // No setup files we know, but the README lists the commands: they're the way in, unchecked for this system.
  if (readmeSteps) {
    reasons.push("There are no setup files we know, but the README lists the commands: follow them in order below.");
    return { status: "maybe", headline: "Maybe: follow the README's steps", reasons };
  }

  reasons.push("We couldn't spot a known setup. The README below is your best guide.");
  return { status: "maybe", headline: "Not sure yet", reasons };
}

export function setupTime(score: number): string {
  if (score <= 2) return "about 5 min";
  if (score <= 5) return "about 15 min";
  return "30 min or more";
}

// How recently someone touched the code: a quick health signal.
export function freshness(pushedAt: string): { label: string; tone: "yes" | "maybe" | "no" } {
  const days = (Date.now() - new Date(pushedAt).getTime()) / 864e5;
  if (days < 30) return { label: "Updated this month", tone: "yes" };
  if (days < 365) return { label: `Updated ${Math.round(days / 30)} months ago`, tone: "yes" };
  return { label: `Quiet for ${(days / 365).toFixed(1)} years`, tone: "maybe" };
}

// "The README gives an install script for macOS", "…a Homebrew install…", "…an apt install…"
function readmeInstall(method: string, os: string): string {
  const what = /script/i.test(method) ? method : `${method} install`;
  return `The README gives ${/^[aeiou]/i.test(what) ? "an" : "a"} ${what} for ${os}.`;
}

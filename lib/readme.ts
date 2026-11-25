import type { OS } from "./os";

export type ReadmeSection = { heading: string; markdown: string; commands: string[] };

// Ordered by how directly the section tells a newcomer what to do.
const SECTION_PRIORITY = [
  /quick ?start/i,
  /getting started|get started/i,
  /^usage$|how to use|^using\b/i,
  /^install(ation|ing)?\b|^setup$|^set ?up\b/i,
  /^run(ning)?\b|^build(ing)?\b/i,
];

const SHELL_LANGS = /^(sh|bash|zsh|shell|console|terminal|shell-session|powershell|ps1|pwsh|cmd|bat)?$/i;

// Finds the README section a newcomer should follow, e.g. "## Quick start".
// Sections that say which devices / platforms / systems a project works on.
export const COMPAT_SECTIONS = [
  /^tested (on|with)\b/i,
  /^(supported|compatible) (devices?|hardware|models?|platforms?|systems?|tvs?)\b/i,
  /^compatib(ility|le)\b/i,
  /^(devices?|platforms?|hardware)\b/i,
  /^(works|runs) (on|with)\b/i,
];

export const UNDO_SECTIONS = [/^(undo|uninstall(ing|ation)?|revert(ing)?|restor(e|ing)|removal|remov(e|ing))\b/i];

export function extractReadmeSection(
  readme: string | undefined,
  priority: RegExp[] = SECTION_PRIORITY,
  opts: { requireCommands?: boolean } = { requireCommands: true },
): ReadmeSection | null {
  if (!readme) return null;
  const lines = readme.split("\n");
  const headings: { level: number; text: string; line: number }[] = [];
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*```/.test(l)) inFence = !inFence;
    const m = !inFence && l.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (m) headings.push({ level: m[1].length, text: m[2].replace(/[*_`]|<[^>]+>|:[\w+-]+:/g, "").trim(), line: i });
  });

  for (const re of priority) {
    const idx = headings.findIndex((h) => re.test(h.text));
    if (idx === -1) continue;
    const h = headings[idx];
    const next = headings.slice(idx + 1).find((n) => n.level <= h.level);
    const body = lines.slice(h.line + 1, next ? next.line : undefined).join("\n").trim();
    const commands = commandsFrom(body);
    // A heading with no commands and little text is usually a table-of-contents stub.
    // A numbered list of inline commands (listSteps) is the setup itself, however short.
    if (opts.requireCommands && !commands.length && body.length < 200 && !listSteps(body).length) continue;
    if (!opts.requireCommands && body.length < 40) continue;
    return { heading: h.text, markdown: truncate(body, 5000), commands };
  }
  return null;
}

export function commandsFrom(markdown: string): string[] {
  const out: string[] = [];
  for (const m of markdown.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)) {
    if (!SHELL_LANGS.test(m[1].trim())) continue;
    for (const raw of m[2].split("\n")) {
      const line = raw.replace(/^\s*(\$|PS>|>)\s+/, "").trimEnd();
      if (line.trim() && !/^\s*#/.test(line)) out.push(line.trim());
    }
  }
  return out;
}

// A setup section written as a numbered list with the command inline instead of in code blocks:
//   1. `scripts/build.sh` (on the Linux host, once): sets up the toolchain and builds it.
//   2. `make install`: installs it.
// Each item becomes a step: its command, and its words as the title and note. Only for a list that's clearly a
// sequence of commands (at least two items that start with one), so a feature list or an FAQ never turns into steps.
export type ListStep = { command: string; text: string; where: string | null };

const CMD_START = /^(\.{0,2}\/|scripts?\/|bin\/|tools\/|[\w.-]+\/[\w./-]+\.(sh|bash|ps1|py|command)\b|[\w.-]+\.(sh|bash|ps1|command)\b|(sudo|make|cmake|ninja|meson|cargo|go|npm|npx|pnpm|yarn|bun|pip3?|pipx|uv|python3?|node|docker|podman|brew|apt(-get)?|dnf|pacman|git|bash|sh|zsh|just|task|mvn|gradle|\.\/gradlew|dotnet|swift|xcodebuild|flutter|insmod|modprobe|dkms|systemctl)\b)/;

const plainText = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

export function listSteps(markdown: string): ListStep[] {
  const text = markdown.replace(/```[\s\S]*?```/g, "");
  const items: string[] = [];
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (m) {
      if (cur !== null) items.push(cur);
      cur = m[1];
    } else if (cur !== null && /^\s{2,}\S/.test(line)) cur += ` ${line.trim()}`; // the item goes on, indented
    else if (cur !== null && line.trim()) {
      items.push(cur);
      cur = null;
    }
  }
  if (cur !== null) items.push(cur);

  const steps: ListStep[] = [];
  for (const item of items) {
    // The command is the inline code the item starts with (allowing "Run " before it).
    const m = /^(?:(?:run|then|next|finally|first)[:,]?\s+)?`([^`]{2,200})`\s*(.*)$/i.exec(item.trim());
    if (!m || !CMD_START.test(m[1].trim())) continue;
    const rest = m[2].replace(/^[,:;—–-]\s*/, "");
    // "(on the Mac)", "(on the arm64 Linux host, once)": which machine it runs on, kept for the note.
    const where = /^\(([^)]{3,80})\)\s*:?\s*/.exec(rest);
    const words = plainText(where ? rest.slice(where[0].length) : rest).replace(/^[,:;—–-]\s*/, "");
    steps.push({ command: m[1].trim(), text: words, where: where ? where[1].trim() : null });
  }
  return steps.length >= 2 ? steps : [];
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  // Don't leave an unclosed code fence.
  return ((cut.match(/```/g)?.length ?? 0) % 2 ? `${cut}\n\`\`\`` : cut) + "\n\n…";
}

type Tool = { name: string; match: RegExp; install: Record<OS, string> };

// Where newcomers most often get stuck, keyed by the command that fails.
const TIPS: [RegExp, string][] = [
  [
    /^adb connect\b/,
    "If `adb connect` says **Connection refused**: ADB debugging is off on the device (turn it on in Developer Options, or restart the device), or the device has no ADB at all — Samsung, LG, Roku and Vizio TVs don't.",
  ],
  [/^adb connect\b/, "If `adb devices` shows **unauthorized**: accept the “Allow USB debugging?” prompt on the device."],
  [/^docker\b/, "If you see **Cannot connect to the Docker daemon**: start Docker Desktop (or the Docker service) first."],
];

export function tipsFor(commands: string[]): string[] {
  return [...new Set(TIPS.filter(([re]) => commands.some((c) => re.test(c))).map(([, t]) => t))];
}

// CLI tools a README's commands assume are installed.
const TOOLS: Tool[] = [
  {
    name: "adb (Android platform-tools)",
    match: /^(adb|fastboot)\b/,
    install: {
      mac: "brew install --cask android-platform-tools",
      windows: "winget install Google.PlatformTools",
      linux: "sudo apt install adb  # Debian/Ubuntu",
    },
  },
  {
    name: "Docker",
    match: /^docker(-compose)?\b/,
    install: {
      mac: "brew install --cask docker  # Docker Desktop",
      windows: "winget install Docker.DockerDesktop",
      linux: "# needs Docker Engine: https://docs.docker.com/engine/install/",
    },
  },
  {
    name: "make",
    match: /^make\b/,
    install: { mac: "xcode-select --install", windows: "winget install GnuWin32.Make  # or use WSL", linux: "sudo apt install make" },
  },
  {
    name: "jq",
    match: /\bjq\b/,
    install: { mac: "brew install jq", windows: "winget install jqlang.jq", linux: "sudo apt install jq" },
  },
  {
    name: "FFmpeg",
    match: /^ffmpeg\b/,
    install: { mac: "brew install ffmpeg", windows: "winget install Gyan.FFmpeg", linux: "sudo apt install ffmpeg" },
  },
  {
    name: "Python 3",
    match: /^(python3?|pip3?)\b/,
    install: { mac: "brew install python", windows: "winget install Python.Python.3.12", linux: "sudo apt install python3 python3-pip" },
  },
  {
    name: "Node.js",
    match: /^(node|npm|npx)\b/,
    install: { mac: "brew install node", windows: "winget install OpenJS.NodeJS.LTS", linux: "# https://nodejs.org/en/download (or nvm)" },
  },
];

export const toolNamed = (name: string): Tool | undefined => TOOLS.find((t) => t.name === name);

export function toolsFor(commands: string[]): Tool[] {
  const firsts = commands.flatMap((c) => c.split(/&&|\|\||;|\|/).map((p) => p.trim().replace(/^sudo\s+/, "")));
  return TOOLS.filter((t) => firsts.some((c) => t.match.test(c)));
}

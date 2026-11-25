// What a repo needs from the computer it runs on: a graphics card (and which kind), memory and disk space. Read from
// the README, the maintainers' setup guide (INSTALL.md, docs/installation.md…) and the project files saved with the
// manual (Dockerfiles, Compose files, Python package lists, .env.example), with rules only (no AI, no GitHub calls), so it works for
// every manual on the shelf. Every need carries the line it came from, so the reader can judge it. The Hardware tab
// on a manual asks for it (app/api/hardware) only when it's opened.

export type GpuVendor = "nvidia" | "amd" | "apple" | "any";
export type Need = {
  quote: string; // the line it came from, cleaned of markdown
  source: string; // the file it came from
};
export type GpuNeed = Need & { vendor: GpuVendor; required: boolean | null; kinds?: GpuVendor[] }; // required null: not said. kinds: a line naming several ("NVIDIA, AMD, Apple Silicon")
export type SizeNeed = Need & { gb: number; level: "minimum" | "recommended" | null };
export type Hardware = {
  gpu: GpuNeed[];
  cpuOnly: Need | null; // the README says it also runs without a GPU (CPU mode)
  memory: SizeNeed[]; // RAM
  vram: SizeNeed[]; // graphics card memory
  disk: SizeNeed[]; // free space, or what it downloads
};

const README = /^readme(\.\w+)?$/i;
// Setup guides by name, for when the manual didn't pick one (guides.doc): never CONTRIBUTING, which is about
// working on the project.
const SETUP_DOC = /(^|\/)(install(ation)?|setup|getting[-_]started|quick[-_]?start|build(ing)?|requirements|hardware)\.(md|mdx|rst|txt)$/i;
// Pages that are about hardware as a whole (ollama's docs/gpu.mdx): fetched with the manual (hardwareDocs) and read
// in full, since every line is about what it runs on.
const HW_DOC = /(^|\/)(gpus?|hardware|hardware[-_]requirements|system[-_]requirements|minimum[-_]requirements|requirements|prerequisites|supported[-_](hardware|gpus?|devices))\.(md|mdx|rst)$/i;
const NOT_DOCS = /(^|\/)(node_modules|vendor|third[-_]party|external|deps|tests?|examples?|\.github)\//i;
// The project's own pages: at the root or in its docs folder, not a sub-component's (vscode's copilot_shim/REQUIREMENTS.md).
const OWN_DOC = (p: string) => !p.includes("/") || /^(docs?|documentation)\//i.test(p);
const MAX_HW_DOCS = 2;

// Which of a repo's files to fetch for the Hardware tab, shallowest first (docs/gpu.mdx before a plugin's own page).
export function hardwareDocs<T extends { path: string; size?: number }>(entries: T[]): T[] {
  return entries
    .filter((e) => HW_DOC.test(e.path) && !NOT_DOCS.test(e.path) && OWN_DOC(e.path) && (e.size ?? 0) <= 200_000)
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .slice(0, MAX_HW_DOCS);
}

const ENV_EXAMPLE = /(^|\/)(\.env\.(example|sample|template|dist|local\.example)|example\.env|env\.example)$/i;
const MAX_QUOTE = 220;

// Markdown and HTML out, one line of plain text.
function plain(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1") // reference-style links: [swap][swap]
    .replace(/[*_`>#|]+/g, " ")
    .replace(/^\s*[-+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const clip = (s: string) => (s.length > MAX_QUOTE ? `${s.slice(0, MAX_QUOTE - 1).trimEnd()}…` : s);

// The README as short lines of prose: code blocks out (they show commands, not requirements), long paragraphs cut
// into sentences, so a quote is the sentence that says it.
// Each sentence keeps the heading it sits under, so "16 GB" under "System requirements" counts as a need.
function sentences(readme: string): { s: string; heading: string }[] {
  const text = readme.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
  const out: { s: string; heading: string }[] = [];
  let heading = "";
  // Paragraphs wrapped over several lines are joined first, so a quote is a whole sentence, not "requires … or".
  let para: string[] = [];
  const flush = () => {
    const raw = para.join(" ").trim();
    const p = plain(raw);
    para = [];
    // A paragraph that's all italic is an image caption ("*The desktop, rendered on the CPU.*"), not a statement.
    if (/^[*_][^*_]/.test(raw) && /[^*_][*_]$/.test(raw)) return;
    if (p.length < 4) return;
    for (const s of p.split(/(?<=[.!?])\s+(?=[A-Z])/)) if (s.length >= 4) out.push({ s, heading });
  };
  for (const line of text.split("\n")) {
    // Markdown and HTML headings, and a line that's all bold ("**Running it with GPU support**"), which READMEs use as one.
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line) ?? /^\s*<h[1-6][^>]*>(.*?)<\/h[1-6]>/i.exec(line) ?? /^\s*(?:\*\*|__)([^*_]{3,80})(?:\*\*|__):?\s*$/.exec(line);
    // A heading, a list item, a table row or an HTML block starts a new piece; a blank line ends one.
    if (h || !line.trim() || /^\s*([-*+]|\d+[.)])\s|^\s*\||^\s*</.test(line)) flush();
    if (h) {
      heading = plain(h[1]);
      para = [line];
      flush();
      continue;
    }
    if (line.trim()) para.push(line);
  }
  flush();
  return out;
}

// Graphics cards by kind. "Apple Silicon" alone is about the chip (which download), not the GPU, and a bare "NVIDIA"
// is often a company or service name (NIM, Tegra), so they don't count; what the code runs on does.
const NVIDIA = /\b(CUDA|cuDNN|TensorRT|GeForce|RTX\s?\d{3,4}|GTX\s?\d{3,4}|A100|H100)\b|\bNVIDIA[\s-](GPUs?|graphics|cards?|drivers?|Container Toolkit)\b/i;
const AMD = /\b(ROCm|Radeon|AMD GPUs?|AMD graphics)\b/;
const APPLE = /\b(MLX|Metal Performance Shaders|MPS( backend)?)\b|\bMetal\b.{0,40}\b(GPU|accelerat\w*)\b/;
const ANY_GPU = /\b(GPUs?|graphics card|Vulkan(?! SDK)|DirectML|OpenCL)\b/i;
const REQUIRED = /\b(requires?|required|requirements?|must|need(s|ed)?|only (works|runs|supports?)|minimum|at least|mandatory|necessary)\b/i;
const OPTIONAL = /\b(optional(ly)?|if (you have|available)|when available|recommended|faster|speed(s|ed)? up|accelerat\w*|supports?|can use|also (works|runs)|whether or not|not required)\b/i;
const CPU_OK = /(?<![/\w])(CPU[- ]only|CPU mode|on (the |your )?CPU(?!\/)|runs? on CPU|without (a )?GPU|no GPU (is )?(needed|required)|CPU inference|--cpu|CPU fallback)\b/i;
// Lines that mention hardware without being about this project's needs: credits, benchmarks, the machine something
// was tested on, changelog entries ("[2026.5.9] v1.3.9 …").
const NOISE = /\b(sponsor|thanks to|benchmark(s|ed)?|leaderboard|tested on|trained on|we used|paper|citation|cite|uses code from|announcing)\b|^\[?\d{4}[.\-/]\d|^v?\d+\.\d+(\.\d+)? [—-]/i;
// Sections that describe the project itself, not what it needs: its folders, licenses, credits, changes.
const NOISE_HEADING = /\b(layout|structure|director(y|ies)|folders?|licen[cs]es?|acknowledg\w*|credits?|contribut\w*|changelog|release notes|history|roadmap|faq)\b/i;
// Any mention of a kind of card, even a bare name, for lines that list several: "for NVIDIA, AMD ROCm, Intel Arc,
// Apple Silicon" means most graphics cards will do, not one of them.
const KINDS: [GpuVendor | "intel", RegExp][] = [
  ["nvidia", /\b(NVIDIA|CUDA)\b/i],
  ["amd", /\b(AMD|ROCm|Radeon)\b/],
  ["apple", /\b(Apple Silicon|Metal|MPS|MLX)\b/],
  ["intel", /\bIntel (Arc|GPUs?|graphics)\b/i],
];

// "Any graphics card" only from a line that says one is needed, not one where "requires" is about something else.
const NEEDS_A_GPU = /\b(requires?|needs?|must have)\s+(an?\s+)?(dedicated\s+|discrete\s+|modern\s+)?(GPU|graphics card)\b|\b(GPU|graphics card)\s+(is\s+)?(required|mandatory|necessary)\b/i;
// Advice for one kind of setup ("If you're running Wayland with an Nvidia GPU, …") isn't a need.
const CONDITIONAL = /^if you('re| are)? (running|using|on)\b/i;
// In a setup guide (not the README), only what sits under a heading like these counts: guides also hold build notes,
// driver workarounds and test details that mention hardware without asking for it.
const GUIDE_HEADING = /requirement|prerequisite|hardware|system|minimum|before you (start|begin)|what you need/i;
// Headings under which a size is a requirement even without "minimum" in the sentence.
const NEEDS_HEADING = /requirement|prerequisite|hardware|system|minimum|before you (start|begin)|what you need|install/i;

const SIZE = String.raw`(\d+(?:\.\d+)?)\s?(TB|GB|GiB|MB|MiB)\b\+?`;
const RAM_AFTER = new RegExp(`${SIZE}\\s*(?:of\\s+)?(?:system\\s+|free\\s+)?(RAM|memory|unified memory)\\b`, "i");
const RAM_BEFORE = /\b(RAM|system memory|memory\s*:)[^.\d]{0,20}?(\d+(?:\.\d+)?)\s?(TB|GB|GiB|MB|MiB)\b/i;
const VRAM_AFTER = new RegExp(`${SIZE}\\s*(?:of\\s+)?(VRAM|GPU memory|video memory|graphics memory)\\b`, "i");
const VRAM_BEFORE = /\b(VRAM|GPU memory|video memory)\b[^.\d]{0,20}?(\d+(?:\.\d+)?)\s?(TB|GB|GiB|MB|MiB)\b/i;
const DISK_AFTER = new RegExp(`${SIZE}\\s*(?:of\\s+)?(?:free\\s+)?(disk(?: space)?|storage|(?:free |hard[- ]drive |drive )?space|SSD|free\\b)`, "i");
const DISK_BEFORE = /\b(disk space|storage|free space)\b[^.\d]{0,20}?(\d+(?:\.\d+)?)\s?(TB|GB|GiB|MB|MiB)\b/i;
const DOWNLOAD = new RegExp(`\\b(download(?:s|ed)?|model(?:s)? (?:is|are|weighs?)|weights? (?:is|are|take)|takes? up)\\b[^.]{0,40}?(?:about |around |~|approx\\.? )?${SIZE}`, "i");

const toGb = (n: number, unit: string) => (/^T/i.test(unit) ? n * 1024 : /^M/i.test(unit) ? n / 1024 : n);
const level = (s: string): SizeNeed["level"] =>
  /\b(minimum|min\.?|at least|as low as|requires?|required|requirements?|need(s)?|baseline)\b/i.test(s) ? "minimum" : /\b(recommend(ed)?|ideally|preferably|for best)\b/i.test(s) ? "recommended" : null;

function sizeFrom(s: string, after: RegExp, before: RegExp): { gb: number } | null {
  const a = after.exec(s);
  if (a) return { gb: toGb(Number(a[1]), a[2]) };
  const b = before.exec(s);
  if (b) return { gb: toGb(Number(b[2]), b[3]) };
  return null;
}

// Sizes worth showing: a sentence about this project's needs, in a believable range.
const believable = (gb: number, max: number) => gb >= 0.25 && gb <= max;

// Project files that only make sense with an NVIDIA card.
function fileSignals(files: Record<string, string>): GpuNeed[] {
  const found: GpuNeed[] = [];
  for (const [path, text] of Object.entries(files)) {
    const name = path.split("/").pop()!.toLowerCase();
    let m: RegExpExecArray | null = null;
    if (/^dockerfile/.test(name) && (m = /^FROM\s+(nvidia\/cuda\S*)/im.exec(text)))
      found.push({ vendor: "nvidia", required: null, quote: clip(`FROM ${m[1]}`), source: path });
    else if (/compose\.ya?ml$|^docker-compose/.test(name) && (m = /^\s*(driver:\s*nvidia|capabilities:\s*\[?\s*gpu|runtime:\s*nvidia)\b.*$/im.exec(text)))
      found.push({ vendor: "nvidia", required: null, quote: clip(m[0].trim()), source: path });
    else if (ENV_EXAMPLE.test(path) && (m = /^\s*#?\s*[A-Z0-9_]*(?:CUDA|NVIDIA)[A-Z0-9_]*\s*=.*$|^\s*#?\s*[A-Z0-9_]*DEVICE\s*=\s*["']?cuda\b.*$/im.exec(text)))
      found.push({ vendor: "nvidia", required: null, quote: clip(m[0].trim()), source: path });
    else if (ENV_EXAMPLE.test(path) && (m = /^\s*#?\s*[A-Z0-9_]*DEVICE\s*=\s*["']?(mps|metal)\b.*$/im.exec(text)))
      found.push({ vendor: "apple", required: null, quote: clip(m[0].trim()), source: path });
    else if (/requirements.*\.txt$|^pyproject\.toml$|^setup\.py$|^environment\.ya?ml$/.test(name) && (m = /^\s*["']?(tensorflow-gpu|onnxruntime-gpu|cupy-cuda\w*|faiss-gpu|flash-attn)\b.*$/im.exec(text)))
      found.push({ vendor: "nvidia", required: null, quote: clip(m[0].trim()), source: path });
  }
  return found;
}

// setupDoc: the guide the manual picked (guides.doc.path), when there is one.
// The sentences to read, with where each came from: the README first (its line is the one quoted when two files say
// the same thing), then hardware pages, then the setup guide.
function readLines(files: Record<string, string>, setupDoc?: string | null) {
  const paths = Object.keys(files);
  const readmePath = paths.find((p) => README.test(p));
  const guide = setupDoc && setupDoc in files ? setupDoc : paths.find((p) => SETUP_DOC.test(p) && !README.test(p));
  const hwDocs = paths.filter((p) => HW_DOC.test(p) && !NOT_DOCS.test(p) && OWN_DOC(p)).slice(0, MAX_HW_DOCS);
  const lines = [...new Set([readmePath, ...hwDocs, guide].filter((p): p is string => Boolean(p)))].flatMap((source) =>
    sentences(files[source]).map((x) => ({ ...x, source })),
  );
  return { lines, readmePath, hwDocs, guide };
}

// ---- The processor it needs: arm64 (ARM) or x86-64 only ----
// A wrong "No" turns people away, so only explicit requirements count: a line under a requirements heading, or one that
// says "only", "requires" or "must", naming one kind of processor. Download lists ("arm64.dmg, x64.exe"), lines naming
// both kinds, and "tested on" machines don't.
export type CpuArch = "arm64" | "x64";
export type CpuNeed = { arch: CpuArch; os: "mac" | "windows" | "linux" | null; quote: string; source: string };
// The processor words. "x86_64" loses its underscore when markdown is cleaned, so a space counts too.
const ARM_WORD = String.raw`(?:arm64|aarch64|ARMv8(?:\.\d)?(?:-A)?|64-bit ARM|ARM64)`;
const X86_WORD = String.raw`(?:x86[-_ ]64(?:-v\d)?|amd64|x64|64-bit (?:Intel|x86))`;
const ARM_ANY = /\b(arm64|aarch64|ARMv\d|ARM64|Arm|ARM|Apple Silicon|M[1-5](?: (?:Pro|Max|Ultra))?)\b/;
const X86_ANY = /\b(x86[-_ ]?64|amd64|x64|x86|Intel|AMD64)\b/i;
// The word has to describe the machine: "an arm64 Linux host", "x86-64 CPU", "architecture: arm64", "arm64 only".
const MACHINE = String.raw`(?:\s+\S+){0,2}?\s+(?:host|machine|computer|cpus?|processors?|system|device|server|hardware|board|pc|platform)\b`;
const ARM_NEED = new RegExp(String.raw`\b${ARM_WORD}${MACHINE}|\b(?:architecture|cpu|processor)s?:?\s+${ARM_WORD}\b|\b${ARM_WORD}[- ]only\b|\bonly (?:on |for )?${ARM_WORD}\b`, "i");
const X86_NEED = new RegExp(String.raw`\b${X86_WORD}${MACHINE}|\b(?:architecture|cpu|processor)s?:?\s+${X86_WORD}\b|\b${X86_WORD}[- ]only\b|\bonly (?:on |for )?${X86_WORD}\b`, "i");
const ONLY = /\b(only|requires?|required|must|needs?)\b/i;
const DOWNLOADS = /\.(dmg|exe|msi|deb|rpm|apk|zip|tar\.(gz|xz|bz2)|tgz|pkg|flatpak|snap)\b|\b(download\w*|AppImage|tarball|flatpak|snap|wheels?|binar(y|ies)|builds?|release)\b/i;

export function cpuNeed(files: Record<string, string>, opts: { setupDoc?: string | null } = {}): CpuNeed | null {
  const { lines, readmePath, hwDocs } = readLines(files, opts.setupDoc);
  for (const { s, heading, source } of lines) {
    if (NOISE.test(s) || NOISE.test(heading) || NOISE_HEADING.test(heading) || DOWNLOADS.test(s) || CONDITIONAL.test(s)) continue;
    // A label on one command or option ("[x86_64 only] Stop the microVM", "(arm64 only)") isn't about the project.
    if (/[[(][^\])]*\b(only|required)\b[^\])]*[\])]/i.test(s)) continue;
    const underNeeds = GUIDE_HEADING.test(heading) || /^(system )?requirements?\s*:/i.test(s);
    // A setup guide (CONTRIBUTING, BUILDING…) only counts under its requirements: elsewhere it's about the maintainers' machines.
    if (source !== readmePath && !hwDocs.includes(source) && !underNeeds) continue;
    const arm = ARM_NEED.test(s);
    const x86 = X86_NEED.test(s);
    if (arm === x86) continue; // neither, or both
    if (!(underNeeds || ONLY.test(s)) || OPTIONAL.test(s)) continue;
    // The other kind anywhere in the same file: then "only" is about one package or command (MarkFlowy's Linux
    // package, firecracker's API examples), not the project. A project that really needs one kind never mentions the other.
    const whole = files[source];
    if (arm ? X86_ANY.test(plain(whole)) : ARM_ANY.test(plain(whole))) continue;
    const os = /\blinux\b/i.test(s) ? "linux" : /\bmacOS\b|\bMac\b/.test(s) ? "mac" : /\bwindows\b/i.test(s) ? "windows" : null;
    return { arch: arm ? "arm64" : "x64", os, quote: clip(s), source };
  }
  return null;
}

export function hardwareNeeds(files: Record<string, string>, opts: { setupDoc?: string | null } = {}): Hardware {
  const { lines, readmePath, hwDocs } = readLines(files, opts.setupDoc);
  const out: Hardware = { gpu: [], cpuOnly: null, memory: [], vram: [], disk: [] };
  const seen = new Set<string>();
  const vendors = new Set<GpuVendor>();

  for (const { s, heading, source } of lines) {
    if (NOISE.test(s) || NOISE.test(heading) || NOISE_HEADING.test(heading)) continue;
    // In a guide, a card or CPU mode only counts under its requirements; a size counts when the sentence says it's
    // needed ("at least 8 GB of RAM") wherever it is.
    const listed = source === readmePath || hwDocs.includes(source) || GUIDE_HEADING.test(heading) || /^(system )?requirements?\s*:/i.test(s);
    // A size counts when the sentence says it's needed, or it sits under a requirements heading.
    const sized = level(s) !== null || (listed && NEEDS_HEADING.test(heading)) || /^(requirements?|RAM|memory|VRAM|disk|storage)\s*:/i.test(s);
    const quote = clip(s);
    const need = { quote, source };
    if (!out.cpuOnly && listed && CPU_OK.test(s)) out.cpuOnly = need;

    // A line naming several kinds of card: most will do (it's "any", optional unless it says otherwise).
    const kinds = KINDS.filter(([, re]) => re.test(s)).map(([k]) => k);
    // Only when the line is about running on them ("for", "supports", "runs on"), not a feature that reads them
    // ("GPU usage / power draw: Nvidia, AMD and Intel").
    const about = REQUIRED.test(s) || OPTIONAL.test(s) || /\b(for|on|via|with|runs?|works?)\b/i.test(s);
    if (listed && about && (kinds.length >= 3 || (kinds.length >= 2 && ANY_GPU.test(s))) && !vendors.has("any")) {
      vendors.add("any");
      out.gpu.push({ ...need, vendor: "any", required: REQUIRED.test(s) && !OPTIONAL.test(s) ? true : false, kinds: kinds.filter((k): k is GpuVendor => k !== "intel") });
      continue;
    }
    const vendor: GpuVendor | null = NVIDIA.test(s) ? "nvidia" : AMD.test(s) ? "amd" : APPLE.test(s) ? "apple" : ANY_GPU.test(s) ? "any" : null;
    // One line per kind of card, the first that says it.
    // "any GPU" only when it's a need ("requires a GPU"): "GPU-accelerated" alone says nothing about the reader's machine.
    if (vendor && listed && s.length >= 20 && !CONDITIONAL.test(s) && !vendors.has(vendor) && (vendor !== "any" || NEEDS_A_GPU.test(s) || /^(system )?requirements?\s*:/i.test(s))) {
      const required = /^(system )?requirements?\s*:/i.test(s) ? true : OPTIONAL.test(s) || CPU_OK.test(s) ? false : REQUIRED.test(s) ? true : null;
      vendors.add(vendor);
      out.gpu.push({ ...need, vendor, required });
    }

    const vram = sized ? sizeFrom(s, VRAM_AFTER, VRAM_BEFORE) : null;
    if (vram && believable(vram.gb, 192) && !seen.has(`v${quote}`)) {
      seen.add(`v${quote}`);
      out.vram.push({ ...need, gb: vram.gb, level: level(s) });
    }
    const ram = sized ? sizeFrom(s, RAM_AFTER, RAM_BEFORE) : null;
    if (ram && believable(ram.gb, 1024) && !seen.has(`r${quote}`)) {
      seen.add(`r${quote}`);
      out.memory.push({ ...need, gb: ram.gb, level: level(s) });
    }
    // What it downloads (models) counts as disk space without "minimum": it's a fact, not a guess.
    const dl = DOWNLOAD.exec(s);
    const disk = (sized ? sizeFrom(s, DISK_AFTER, DISK_BEFORE) : null) ?? (dl ? { gb: toGb(Number(dl[2]), dl[3]) } : null);
    if (disk && believable(disk.gb, 4096) && !seen.has(`d${quote}`)) {
      seen.add(`d${quote}`);
      out.disk.push({ ...need, gb: disk.gb, level: level(s) });
    }
  }

  // A card only the project files point to (a CUDA image, a GPU-only package, DEVICE=cuda), when the guides didn't say.
  for (const f of fileSignals(files)) {
    if (vendors.has(f.vendor)) continue;
    vendors.add(f.vendor);
    out.gpu.push(f);
  }
  const cap = <T,>(xs: T[]) => xs.slice(0, 3);
  return { gpu: out.gpu.slice(0, 4), cpuOnly: out.cpuOnly, memory: cap(out.memory), vram: cap(out.vram), disk: cap(out.disk) };
}

export const hasHardware = (h: Hardware) => h.gpu.length + h.memory.length + h.vram.length + h.disk.length > 0;

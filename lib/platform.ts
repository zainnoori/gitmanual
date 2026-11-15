import type { TreeEntry } from "./github";
import type { Release } from "./install";
import { OS_LIST, type OS } from "./os";

// "Made for one system": the dock for Windows 11, the macOS menu-bar app, the Wayland compositor. Without this, a
// project with no download for your system read as "you'll build it yourself", which can't work when the code is
// written against Windows, macOS or Linux alone. Signals from different places (what it says about itself, the
// libraries the code uses, its project files, its downloads, its CI) are counted per system; two or more agreeing
// make it sure, one makes it likely. Anything published or tested for a second system rules it out entirely, so
// cross-platform projects with some system-specific code (a terminal's Windows backend) are never caught.

export type PlatformOnly = { os: OS; sure: boolean; signals: string[] };

// The files worth reading for this, beyond the ones the manual already reads: workspace members and project files,
// where a project says which system its code is written for. A handful at most.
export function platformFiles(entries: TreeEntry[]): TreeEntry[] {
  const out: TreeEntry[] = [];
  const minor = /(^|\/)(tests?|examples?|samples?|docs?|benches|fuzz|third[-_]?party|vendor|external)\//i;
  const pick = (re: RegExp, max: number, depth = 4) =>
    entries
      .filter((e) => re.test(e.path) && e.path.split("/").length <= depth && !minor.test(e.path) && (e.size ?? 0) < 200_000)
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length)
      .slice(0, max)
      .forEach((e) => out.push(e));
  pick(/(^|\/)Cargo\.toml$/, 6);
  pick(/\.(csproj|vbproj|fsproj)$/, 4);
  pick(/^Package\.swift$/, 1, 1);
  pick(/^(meson\.build|CMakeLists\.txt|configure\.ac)$/, 2, 1);
  return out;
}

type Input = {
  description: string | null;
  readme: string | undefined;
  paths: string[];
  files: Record<string, string>; // platformFiles plus the workflows the manual already read
  release: Release | null;
  language: string | null;
};

const LABEL: Record<OS, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

export function platformOnly(i: Input): PlatformOnly | null {
  const found: Record<OS, string[]> = { mac: [], windows: [], linux: [] };
  const add = (os: OS, signal: string) => found[os].includes(signal) || found[os].push(signal);

  // 1. What it says about itself: the description, and the README's opening (not its install section, where
  //    cross-platform projects list every system).
  const intro = `${i.description ?? ""}\n${(i.readme ?? "").replace(/<[^>]+>|!\[[^\]]*\]\([^)]*\)|\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, " ").slice(0, 900)}`;
  // "Cross-platform", or several systems named together: what it says about itself doesn't single one out.
  const several = /cross[- ]platform|multi[- ]platform|\b(Windows|macOS|Linux)\s*(,|\/|and|&)\s*(Windows|macOS|Linux)\b|all (major )?(platforms|operating systems)/i.test(intro);
  if (!several) {
    if (/\b(for|on) Windows( 1[01])?\b|\bWindows[- ](only|1[01] (app|tool|utility|dock|taskbar))\b|\bWindows (taskbar|explorer|shell)\b|\bfor (the )?Windows (desktop|users)\b/i.test(intro))
      add("windows", "it describes itself as made for Windows");
    // "macOS-style" or "macOS-inspired" is a look, not a system.
    if (/\b(for|on) macOS\b|\bmacOS[- ](only|app|menu ?bar|utility)\b|\bmenu ?bar (app|manager|utility)\b|\b(for|on) (your )?Mac\b|\bMac app\b/i.test(intro))
      add("mac", "it describes itself as made for macOS");
    if (/\bWayland (compositor|bar)\b|\bwlroots\b|\b(X11|Wayland) window manager\b|\bGNOME Shell extension\b|\bKDE Plasma (applet|widget)\b|\b(for|on) Linux( desktops?)?\b/i.test(intro))
      add("linux", "it describes itself as made for Linux (Wayland, X11 or a Linux desktop)");
  }

  // 2. The libraries its code uses, when they're used everywhere and not only behind a "this system" switch.
  for (const [path, text] of Object.entries(i.files)) {
    if (/Cargo\.toml$/.test(path)) {
      const general = text.replace(/^\[target\.[^\]]+\][\s\S]*?(?=^\[(?!target\.)|(?![\s\S]))/gm, ""); // drop [target.'cfg(…)'.*] sections
      if (/^\s*(windows|windows-sys|winapi|winreg|windows-core)\s*=/m.test(general.replace(/^\[(dev-|build-)dependencies\][\s\S]*?(?=^\[|(?![\s\S]))/gm, "")))
        add("windows", `its Rust code uses Windows system libraries (${path})`);
      if (/^\s*(cocoa|objc2-app-kit|core-foundation|core-graphics|objc2|appkit-nsworkspace-bindings)\s*=/m.test(general) && !/^\s*(windows|winapi|gtk|x11|wayland)/m.test(text))
        add("mac", `its Rust code uses macOS system libraries (${path})`);
      if (/^\s*(wayland-client|wayland-server|smithay|wlroots|x11rb|xcb)\s*=/m.test(general) && !/^\s*(windows|winapi|cocoa|objc2)/m.test(text))
        add("linux", `its Rust code uses Linux display libraries (${path})`);
    }
    if (/\.(csproj|vbproj|fsproj)$/.test(path) && /<(UseWPF|UseWindowsForms|UseWinUI)>\s*true|<TargetFrameworks?>[^<]*-windows|<TargetFrameworkVersion>v4|Microsoft\.WindowsAppSDK|Microsoft\.Windows\.SDK/i.test(text))
      add("windows", `it's a Windows desktop app (WPF, WinForms or WinUI in ${path.split("/").pop()})`);
    if (path === "Package.swift" && /platforms:\s*\[[^\]]*\.macOS/.test(text) && !/\.(iOS|linux)/i.test(text)) add("mac", "its Swift package targets macOS only");
    if (/^(meson\.build|CMakeLists\.txt|configure\.ac)$/.test(path) && /wayland-(server|client|protocols)|wlroots|\bwlr\b/i.test(text) && !/\bWIN32\b|\bAPPLE\b|\bdarwin\b|\bMSVC\b/.test(text))
      add("linux", `it builds against Wayland (${path})`);
  }
  // Project files that only one system's tools open.
  const has = (re: RegExp) => i.paths.some((p) => re.test(p));
  // (A package.json beside it is usually release tooling, not another app.)
  if (has(/\.xcodeproj\//) && !has(/\.(csproj|vcxproj)$/) && !has(/(^|\/)(CMakeLists\.txt|meson\.build|Cargo\.toml|go\.mod|build\.gradle(\.kts)?)$/) && /^(Swift|Objective-C)$/.test(i.language ?? ""))
    add("mac", "it's an Xcode project in Swift or Objective-C");
  if (has(/\.(sln|vcxproj)$/) && !has(/(^|\/)(CMakeLists\.txt|meson\.build|Makefile|configure\.ac|Cargo\.toml|go\.mod|package\.json)$/) && /^(C\+\+|C|C#)$/.test(i.language ?? ""))
    add("windows", "it's a Visual Studio solution with no build files for other systems");

  // 3. What it publishes, and where it's tested.
  const assetOs = [...new Set((i.release?.assets ?? []).map((a) => a.os))];
  if (assetOs.length === 1) add(assetOs[0], `its releases only have ${LABEL[assetOs[0]]} downloads`);
  const runners = Object.entries(i.files)
    .filter(([p]) => /^\.github\/workflows\//.test(p))
    .flatMap(([, t]) => [...t.matchAll(/runs-on:\s*\[?\s*['"]?([\w.-]+)/g)].map((m) => m[1].toLowerCase()))
    .filter((r) => !/^\$\{\{/.test(r));
  const ciOs = [...new Set(runners.map((r) => (/windows/.test(r) ? "windows" : /macos/.test(r) ? "mac" : /ubuntu|linux/.test(r) ? "linux" : null)).filter((x): x is OS => Boolean(x)))];
  if (ciOs.length === 1 && ciOs[0] !== "linux") add(ciOs[0], `its CI builds and tests on ${LABEL[ciOs[0]]} only`); // Linux-only CI is common for everything

  // Ruled out: a download or CI for a second system means it's cross-platform, whatever else it says.
  const pick = (OS_LIST.filter((os) => found[os].length) as OS[]).sort((a, b) => found[b].length - found[a].length)[0];
  if (!pick) return null;
  if (assetOs.some((o) => o !== pick) || ciOs.some((o) => o !== pick && o !== "linux")) return null;
  if (OS_LIST.some((o) => o !== pick && found[o].length)) return null; // mixed signals: say nothing rather than guess
  // One of each kind of sign: three .csproj files are one reason, not three.
  const kinds = [...new Map(found[pick].map((x) => [x.replace(/\s*\([^)]*\)$/, ""), x])).values()];
  return { os: pick, sure: kinds.length >= 2, signals: kinds };
}

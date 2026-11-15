import assert from "node:assert/strict";
import { test } from "node:test";
import { platformOnly } from "../lib/platform";

// "Made for one system": the dock for Windows 11, the macOS menu-bar app, the Wayland compositor. Two kinds of sign
// make it sure; anything published or tested for another system rules it out.

const base = { description: null, readme: "", paths: [] as string[], files: {} as Record<string, string>, release: null, language: null };
const rel = (...os: ("mac" | "windows" | "linux")[]) => ({ tag: "v1", assets: os.map((o) => ({ os: o })) }) as never;

test("a Windows dock in Rust: said, coded and released for Windows only", () => {
  const r = platformOnly({
    ...base,
    description: "A lightweight, macOS-style dock for Windows 11",
    files: { "apps/dock/Cargo.toml": '[dependencies]\nwindows = { workspace = true, features = ["Win32_UI_Shell"] }' },
    release: rel("windows"),
  });
  assert.equal(r?.os, "windows");
  assert.equal(r?.sure, true); // "macOS-style" is a look, not a system
});

test("Windows-only Rust code behind a cfg(windows) switch isn't a sign", () => {
  const r = platformOnly({ ...base, files: { "Cargo.toml": "[dependencies]\nserde = \"1\"\n\n[target.'cfg(windows)'.dependencies]\nwindows-sys = \"0.59\"\n" } });
  assert.equal(r, null);
});

test("WPF, WinForms or WinUI make it a Windows app; a plain .NET project doesn't", () => {
  const wpf = platformOnly({ ...base, description: "Volume Control for Windows", files: { "src/App.csproj": "<PropertyGroup><TargetFramework>net8.0-windows</TargetFramework><UseWPF>true</UseWPF></PropertyGroup>" } });
  assert.equal(wpf?.os, "windows");
  assert.equal(wpf?.sure, true);
  assert.equal(platformOnly({ ...base, files: { "src/Server.csproj": "<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>" } }), null);
});

test("a macOS menu-bar app: said and built as an Xcode Swift project", () => {
  const r = platformOnly({ ...base, description: "Powerful menu bar manager for macOS", language: "Swift", paths: ["Ice.xcodeproj/project.pbxproj", "package.json"] });
  assert.equal(r?.os, "mac");
  assert.equal(r?.sure, true);
});

test("a Wayland compositor: said and built against Wayland", () => {
  const r = platformOnly({ ...base, description: "A dynamic tiling Wayland compositor", files: { "meson.build": "dep = dependency('wayland-server')\nwindowrules = []" } });
  assert.equal(r?.os, "linux");
  assert.equal(r?.sure, true);
});

test("cross-platform projects are never caught, whatever system-specific code they hold", () => {
  // Downloads for a second system rule it out.
  assert.equal(platformOnly({ ...base, description: "A terminal for Windows", release: rel("windows", "mac") }), null);
  // CI on a second system (besides Linux, which everything uses) rules it out.
  assert.equal(platformOnly({ ...base, description: "for Windows", files: { ".github/workflows/ci.yml": "jobs:\n  a:\n    runs-on: windows-latest\n  b:\n    runs-on: macos-latest" } }), null);
  // Saying several systems, or "cross-platform", isn't a claim about one.
  assert.equal(platformOnly({ ...base, description: "Runs on Windows, macOS and Linux" }), null);
  assert.equal(platformOnly({ ...base, description: "A cross-platform alternative to AirDrop, for Windows users too" }), null);
});

test("one sign alone is 'probably', not sure", () => {
  const r = platformOnly({ ...base, description: "Quick file search for Windows" });
  assert.deepEqual([r?.os, r?.sure], ["windows", false]);
});
